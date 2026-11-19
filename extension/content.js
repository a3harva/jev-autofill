// Reads the fields on a page, maps each to a key, and fills it from the local profile.
// It never submits and never changes a field that already has a value.
(() => {
  if (window.__jevRun) return;

  const NO_FILL = new Set(["free_text", "leave_blank", "unknown", "notifications_opt_in"]);
  const PLACE_KEYS = new Set(["current_location", "city", "preferred_location"]);
  const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // The user's own calendar date; toISOString would give the UTC date, a day off east of UTC before dawn.
  const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // Countries and big job cities, used to tell whether a job is in the candidate's home country or abroad.
  const PLACES = /\b(india|bengaluru|bangalore|mumbai|pune|hyderabad|gurgaon|gurugram|noida|delhi|chennai|kolkata|ahmedabad|united states|usa|united kingdom|uk|canada|toronto|vancouver|germany|berlin|munich|netherlands|amsterdam|ireland|dublin|france|paris|spain|madrid|barcelona|poland|warsaw|sweden|stockholm|switzerland|zurich|singapore|dubai|uae|australia|sydney|melbourne|japan|tokyo|london|new york|san francisco|seattle|austin|boston)\b/gi;
  const ACTION_WORDS = /apply|submit|save|next|continue|back|cancel|delete|remove|sign|log ?in|upload|attach|send|share|follow/i;
  let seen = new WeakSet();
  let report;
  let config = {};
  let tabTitle = "";
  let deadline = 0;

  function publish() {
    let el = document.getElementById("jev-auto-mapper-report");
    if (!el) {
      el = document.createElement("script");
      el.type = "application/json";
      el.id = "jev-auto-mapper-report";
      document.documentElement.appendChild(el);
    }
    el.textContent = JSON.stringify(report);
  }

  // Fields inside web components (open shadow roots), as on SmartRecruiters, are searched too.
  function deepAll(root, selector) {
    const out = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot) out.push(...deepAll(host.shadowRoot, selector));
    return out;
  }
  // An id is looked up in the field's own shadow root first, then in the page.
  const byId = (el, id) => (id && ((el.getRootNode().getElementById && el.getRootNode().getElementById(id)) || document.getElementById(id))) || null;

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const textOf = (el) => (el ? (el.innerText || el.textContent || "").replace(/[\s\u200b]+/g, " ").trim() : "");
  // What a picker button shows, counting a flag or icon that carries the choice in its alt text.
  const shownOf = (el) => textOf(el) || [...el.querySelectorAll("img[alt]")].map((i) => i.alt).join(" ").trim();

  function labelOf(el) {
    if (el.type === "file") {
      const named = textOf(byId(el, el.closest('[role="group"][aria-labelledby]')?.getAttribute("aria-labelledby")));
      if (named) return named;
      const wrap = el.closest("[aria-labelledby]");
      const wrapped = wrap && wrap.getAttribute("aria-labelledby").split(/\s+/).map((id) => textOf(byId(el, id))).join(" ").trim();
      if (wrapped) return wrapped;
    }
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => textOf(byId(el, id))).join(" ").trim();
      if (t) return t;
    }
    if (el.labels && el.labels[0]) return textOf(el.labels[0]);
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
    let node = el;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        const t = textOf(prev);
        if (t) return t.slice(0, 300);
      }
    }
    return "";
  }

  function sectionOf(el) {
    const box = el.closest("section, fieldset");
    const named = el.closest('[class*="employ" i], [id*="employ" i], [class*="experience" i], [id*="experience" i], [class*="education" i], [id*="education" i]');
    // A block's class name, such as Greenhouse's employment-form, is the last hint.
    const hint = named ? (/educat/i.test(named.className + named.id) ? "Education" : "Employment") : "";
    return textOf(box && box.querySelector("h1, h2, h3, h4, legend")) || groupOf(el) || hint;
  }

  // The heading of a block of boxes, such as "Reference 1" above Name / Email / Phone. It stops at another field so a neighbour's label is never taken.
  function groupOf(el) {
    const own = el.labels ? [...el.labels] : [];
    let node = el;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (own.includes(prev)) continue;
        if (prev.matches("input, select, textarea") || prev.querySelector("input, select, textarea")) break;
        if (prev.matches("label, legend, h1, h2, h3, h4, h5, [role=heading]") || prev.querySelector("label, legend, h1, h2, h3, h4, h5, [role=heading]")) {
          const t = textOf(prev);
          if (t) return t.slice(0, 100);
        }
      }
    }
    return "";
  }

  // A choice drawn as a div carries its text in aria-label or data-value, as Google Forms does.
  const choiceText = (b) => textOf(b) || b.getAttribute("aria-label") || b.getAttribute("data-value") || "";
  const optionLabel = (input) => textOf(input.labels && input.labels[0]) || textOf(input.closest("label")) || input.value;

  // Sites often show an uploaded file as a card and clear the input itself.
  function hasAttachment(el) {
    const box = el.closest('[role="group"][aria-labelledby], fieldset') || el.parentElement || el;
    // A file name, not the accepted-types hint such as "(.doc / .docx / .pdf)".
    return Boolean(box.querySelector('[data-automation-id="delete-file"]')) || /[\w)-]\.(pdf|docx?)\b/i.test(textOf(box));
  }

  function collect() {
    const fields = [];
    const radios = new Set();
    const fieldCount = (d) => [...d.querySelectorAll("input, select, textarea")].filter(visible).length;
    const openDialog = [...document.querySelectorAll('dialog[open], [role="dialog"]')].filter((d) => visible(d) && fieldCount(d)).sort((a, b) => fieldCount(b) - fieldCount(a))[0];
    for (const el of deepAll(openDialog || document, 'input, textarea, select, [role="combobox"], [role="radiogroup"], button[aria-haspopup="listbox"], div:has(> button[aria-pressed])')) {
      if (seen.has(el)) continue;
      if (self.__jevWorkdayPresent() && self.__jevWorkdayHandles(el)) continue;
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (el.id.startsWith("iti-")) continue;
      // Site-wide search and navigation are never part of an application. A dropdown's own search box (Ant Design's type=search combobox) is.
      const picker = el.getAttribute("role") === "combobox" && el.closest('[class*="select" i]');
      if (el.closest('header, nav, [role="banner"], [role="navigation"], [role="search"]') || (!picker && (el.closest('[class*="search" i], [id*="search" i]') || el.type === "search" || el.getAttribute("role") === "searchbox"))) continue;
      const pick = el.tagName === "BUTTON" && (el.getAttribute("role") === "combobox" || el.getAttribute("aria-haspopup") === "listbox");
      if (!pick && ["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
      if (type === "radio") {
        const group = [...el.getRootNode().querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)];
        if (radios.has(el.name)) continue;
        radios.add(el.name);
        group.forEach((r) => seen.add(r));
        if (group.some((r) => r.checked)) continue;
        const box = el.closest("fieldset");
        let around = el;
        while (around.parentElement && !group.every((r) => around.contains(r))) around = around.parentElement;
        fields.push({ el, id: el.name, control: "radio", group, label: textOf(box && box.querySelector("legend")) || labelOf(around), section: sectionOf((box && box.parentElement) || box || el), options: group.map(optionLabel) });
        continue;
      }
      if (el.getAttribute("role") === "radiogroup" || (el.tagName === "DIV" && el.querySelector(":scope > button[aria-pressed]"))) {
        seen.add(el);
        const buttons = [...el.querySelectorAll("button, [role=radio]")];
        // Only real answer choices: a row holding Apply, Save or Next is page navigation and must never be clicked.
        if (buttons.length < 2 || buttons.some((b) => ACTION_WORDS.test(choiceText(b)))) continue;
        if (buttons.some((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true")) continue;
        el.id = el.id || `jev-${fields.length}`;
      fields.push({ el, id: el.id, control: "buttons", buttons, label: labelOf(el), section: sectionOf(el), options: buttons.map(choiceText) });
        continue;
      }
      // A see-through native select under a drawn dropdown only mirrors it; the drawn one is what the page listens to.
      // Select2 is the exception: it follows its own hidden select.
      if (el.tagName === "SELECT" && !el.classList.contains("select2-hidden-accessible") && (getComputedStyle(el).opacity === "0" || el.getBoundingClientRect().width <= 2) && el.parentElement?.querySelector('[role="combobox"], button[aria-haspopup="listbox"]')) continue;
      // A read-only box is skipped unless it is a dropdown's own input (Ant Design's).
      if (el.disabled || (el.readOnly && !picker) || !(visible(el) || type === "file")) continue;
      seen.add(el);
      // A phone or email box that suggests values is still typed into.
      const control = pick || (el.getAttribute("role") === "combobox" && !["tel", "email"].includes(type)) ? "combobox" : el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : type;
      if (el.closest('[class*="select__control"]')?.querySelector('[class*="select__single-value"]') || el.closest(".ant-select")?.querySelector(".ant-select-selection-item")) continue;
      if (pick ? !/^(|select.*|choose.*|please.*|-+)$/i.test(shownOf(el)) : control === "checkbox" ? el.checked : control === "file" ? el.files.length || hasAttachment(el) : control === "select" ? el.selectedIndex > 0 && el.value : el.value) continue;
      const label = labelOf(el) || (/^select\b/i.test(el.placeholder) ? "" : el.placeholder) || "";
      if (!label || /^(select|search)\b/i.test(label)) continue;
      fields.push({ el, id: el.id || el.name, control, label, section: sectionOf(el), options: control === "select" ? [...el.options].filter((o) => o.value).map((o) => o.text) : [] });
    }
    return fields;
  }

  // The option that means the same as a profile value: exact, contained, Yes/No, or the bracket holding a number.
  function matchOption(options, value) {
    const want = norm(value);
    const word = new RegExp(`(^|[^a-z0-9])${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
    const wanted = new Set(want.split(/[^a-z0-9]+/));
    const allWords = options.find((o) => {
      const words = norm(o).split(/[^a-z0-9]+/).filter(Boolean);
      return words.length >= 3 && words.every((w) => wanted.has(w));
    });
    let hit = options.find((o) => norm(o) === want) || allWords || (want !== "yes" && want !== "no" && want.length > 2 ? options.find((o) => word.test(norm(o))) : undefined) || options.find((o) => want.includes(norm(o)) && norm(o).length > 2);
    if (hit) return hit;
    // Two options that both start with Yes mean different things, so neither can be assumed.
    if (want === "yes" || want === "no") {
      const same = options.filter((o) => new RegExp(`^${want}\\b`).test(norm(o)));
      return same.length === 1 ? same[0] : undefined;
    }
    // Choices of one or two letters, such as M / F, stand for the word they start.
    if (options.every((o) => norm(o).length <= 2)) {
      const initial = options.filter((o) => norm(o) && want.startsWith(norm(o)));
      if (initial.length === 1) return initial[0];
    }
    const n = parseFloat(want);
    if (Number.isNaN(n)) return undefined;
    const range = (o) => norm(o).match(/(\d+(?:\.\d+)?)\s*(?:-|–|to|,)\s*(\d+(?:\.\d+)?)/);
    const less = (o) => norm(o).match(/(?:less than|under|below|<)\s*(\d+(?:\.\d+)?)/);
    // "15 days" for 15: an option that is just the number with a unit.
    const same = options.find((o) => !range(o) && !less(o) && new RegExp(`^\\D{0,3}${n}(?!\\d|\\.\\d|\\s*\\+)`).test(norm(o)));
    if (same) return same;
    // Brackets often share their edges (2-4, 4-6); the one starting at the number wins.
    return options.find((o) => range(o) && n >= +range(o)[1] && n < +range(o)[2]) || options.find((o) => {
      if (range(o)) return n >= +range(o)[1] && n <= +range(o)[2];
      if (less(o)) return n < +less(o)[1];
      const plus = norm(o).match(/(\d+(?:\.\d+)?)\s*\+/);
      return plus ? n >= +plus[1] : false;
    });
  }

  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    // Composed, so a web component listening outside its shadow root hears it, as with real typing.
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  let resumeAttached = false;
  let profile = {};
  // The candidate's home country from the profile: { country, codes, places }.
  let home = null;

  async function attachResume(el) {
    if (location.hostname.endsWith("linkedin.com")) return "LinkedIn uses the saved resume card";
    // One upload widget can hold several file boxes; the resume goes in once per run.
    if (resumeAttached) return "the resume is already attached";
    const file = await chrome.runtime.sendMessage({ type: "resume" });
    if (!file) return "the helper did not answer";
    if (file.error) return file.error;
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], file.name, { type: "application/pdf" }));
    el.files = dt.files;
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    for (let i = 0; i < 10; i++) {
      if (el.files.length || hasAttachment(el)) return (resumeAttached = true), null;
      await sleep(300);
    }
    return "the file did not attach";
  }

  // Returns null when filled, or the reason it was not.
  async function fill(f, key, value) {
    if (key === "linkedin_url") value = value.replace(/^https?:\/\/(www\.)?linkedin\.com/i, "https://www.linkedin.com");
    if (f.control === "file") return key === "resume_upload" ? attachResume(f.el) : "only the resume is attached";
    if (f.control === "checkbox") {
      if (norm(value) !== "yes") return "not a yes";
      f.el.click();
      return f.el.checked ? null : "the box did not take a click";
    }
    if (f.control === "select") {
      const label = matchOption(f.options, value);
      const opt = label && [...f.el.options].find((o) => o.text === label);
      if (!opt) return "no matching option";
      setValue(f.el, opt.value);
      return f.el.value === opt.value ? null : "the value did not hold";
    }
    if (f.control === "radio") {
      const label = matchOption(f.options, value);
      if (!label) return "no matching option";
      const r = f.group[f.options.indexOf(label)];
      r.click();
      return r.checked ? null : "the option did not take a click";
    }
    if (f.control === "buttons") {
      const label = matchOption(f.options, value);
      if (!label) return "no matching option";
      f.buttons[f.options.indexOf(label)].click();
      return null;
    }
    if (f.control === "combobox") {
      const typed = f.el.tagName === "INPUT";
      let list = await openPicker(f.el);
      let label = matchOption(list.map(textOf), value);
      if (!label && typed) {
        setValue(f.el, value);
        list = await visibleOptions();
        label = matchOption(list.map(textOf), value);
      }
      if (!label) {
        if (typed) setValue(f.el, "");
        closePicker(f.el);
        return "no matching option";
      }
      const option = list.find((o) => textOf(o) === label);
      option.scrollIntoView({ block: "nearest" });
      self.__jevPress(option);
      await sleep(typed ? 50 : 500);
      // A library picker shows the choice beside its input, not in it.
      const holder = reactControl(f.el) || f.el.closest(".ant-select, .el-select, .v-select, .select2-container");
      const shown = holder ? textOf(holder) : typed ? f.el.value : textOf(f.el);
      return (typed && !holder ? shown : shown && (norm(label).includes(norm(shown)) || norm(shown).includes(norm(label)))) ? null : "the value did not hold";
    }
    if (!["checkbox", "file", "select", "radio", "buttons", "combobox"].includes(f.control) && f.el.getAttribute("aria-autocomplete")) {
      f.el.focus();
      setValue(f.el, value);
      const list = await visibleOptions();
      const label = matchOption(list.map(textOf), value);
      if (label) self.__jevPress(list.find((o) => textOf(o) === label));
      await sleep(200);
      f.el.blur();
      return f.el.value ? null : "the value did not hold";
    }
    if (f.control === "date") {
      const days = value.match(/(\d+)\s*days?/i);
      if (days) value = localDate(new Date(Date.now() + days[1] * 864e5));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "not a full date";
    }
    if (key === "phone") await setDialCode(f.el);
    f.el.focus();
    setValue(f.el, value);
    f.el.blur();
    const digits = (x) => x.replace(/\D/g, "");
    // A phone box that adds a dialling code of its own, such as +62, is given the full number so it switches to the right country.
    const full = profile.phone_with_country_code;
    if (key === "phone" && full && /^\+/.test(f.el.value) && !digits(f.el.value).startsWith(digits(full).slice(0, digits(full).length - digits(value).length))) {
      f.el.focus();
      setValue(f.el, full);
      f.el.blur();
      value = full;
    }
    // A site may tidy what was entered, such as formatting a phone number or completing a place name.
    if (f.el.value === value || ((f.control === "tel" || /phone/.test(key)) && digits(value).length >= 7 && digits(f.el.value).endsWith(digits(value).slice(-10))) || (value.length > 3 && norm(f.el.value).startsWith(norm(value).slice(0, 4)))) return null;
    return PLACE_KEYS.has(key) && f.el.tagName === "INPUT" ? typeahead(f.el, value) : "the value did not hold";
  }

  // A place box that keeps only a value picked from its suggestions: the city is typed key by key and the best suggestion pressed.
  async function typeahead(el, value) {
    const city = value.split(",")[0].trim();
    const region = norm(value.split(",")[1] || "");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    set.call(el, "");
    for (const ch of city) {
      const at = { key: ch, bubbles: true };
      el.dispatchEvent(new KeyboardEvent("keydown", at));
      el.dispatchEvent(new KeyboardEvent("keypress", at));
      set.call(el, el.value + ch);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(new KeyboardEvent("keyup", at));
      await sleep(60);
    }
    const want = norm(city);
    for (let i = 0; i < 15; i++) {
      await sleep(300);
      const top = el.getBoundingClientRect().top - 400;
      const hits = [...deepAll(document, '[role="option"], li, [class*="option" i], [class*="suggest" i], [class*="result" i] > *, [class*="location" i], .pac-item')]
        .filter((o) => !o.contains(el) && visible(o) && !o.querySelector("input") && textOf(o).length < 150 && norm(textOf(o)).startsWith(want) && o.getBoundingClientRect().top >= top)
        // The innermost element is the one a click lands on.
        .filter((o, _, all) => !all.some((x) => x !== o && o.contains(x)));
      if (!hits.length) continue;
      const pick = hits.find((o) => region && norm(textOf(o)).includes(region)) || hits[0];
      pick.scrollIntoView({ block: "nearest" });
      self.__jevPress(pick);
      await sleep(400);
      el.blur();
      await sleep(300);
      return el.value ? null : "the value did not hold";
    }
    el.blur();
    return el.value ? null : "no suggestion appeared";
  }

  // A dialling-code picker beside the phone box is set to the candidate's code first, so the number is read in the right country.
  async function setDialCode(el) {
    const code = (profile.phone_country_code || "").replace(/\D/g, "");
    if (!code) return;
    const shown = (p) => (p.tagName === "SELECT" ? textOf(p.selectedOptions && p.selectedOptions[0]) : p.value || shownOf(p));
    let box = el.parentElement;
    for (let depth = 0; box && depth < 5; depth++, box = box.parentElement) {
      const pick = deepAll(box, 'select, input[role="combobox"], [role="combobox"], button[aria-haspopup]').find((p) => p !== el && /\+\s?\d{1,4}/.test(shown(p)));
      if (pick) {
        if (new RegExp(`\\+\\s?${code}\\b`).test(shown(pick))) return;
        const wanted = (options) => options.find((o) => home?.country && norm(o).includes(norm(home.country)) && new RegExp(`\\+\\s?${code}\\b`).test(o)) || options.find((o) => new RegExp(`^\\+\\s?${code}\\b|\\(\\+${code}\\)`).test(o.trim())) || (home?.country && matchOption(options, home.country));
        if (pick.tagName === "SELECT") {
          const label = wanted([...pick.options].map((o) => o.text));
          const opt = label && [...pick.options].find((o) => o.text === label);
          if (opt) setValue(pick, opt.value);
          return;
        }
        pick.scrollIntoView({ block: "center" });
        pick.focus();
        self.__jevPress(pick);
        if (pick.tagName === "INPUT" && home?.country) setValue(pick, home.country);
        const list = await visibleOptions();
        const label = wanted(list.map(textOf));
        if (label) self.__jevPress(list.find((o) => textOf(o) === label));
        else closePicker(pick);
        await sleep(300);
        return;
      }
      // Past the phone's own block: another box means the picker, if any, belongs to a different field.
      if (deepAll(box, "input:not([type=hidden]), textarea").some((x) => x !== el && x.getAttribute("role") !== "combobox")) return;
    }
  }

  // A list of dialling codes beside a phone box, whatever its label says.
  const dialCodes = (options) => options.length >= 5 && options.filter((o) => /\+\s?\d{1,4}\b/.test(o)).length >= options.length * 0.6;

  // Options from ARIA lists and the common libraries that draw theirs without a role (Ant Design, Element, Select2, Angular Material, PrimeNG).
  const OPTION = '[role="option"], .ant-select-item-option, .el-select-dropdown__item, .select2-results__option, mat-option, .p-dropdown-item';

  async function visibleOptions(tries = 10) {
    for (let i = 0; i < tries; i++) {
      await sleep(200);
      const list = deepAll(document, OPTION).filter((o) => visible(o) && !/^select\b/i.test(textOf(o)) && !o.closest('[class*="iti"]'));
      if (list.length) return list;
    }
    return [];
  }

  const reactControl = (el) => el.closest('[class*="select__control"]');

  // A searchable picker opens on a press once its input has focus; a button opens on a plain click.
  async function openPicker(el) {
    el.scrollIntoView({ block: "center" });
    if (el.getAttribute("aria-expanded") === "true") return visibleOptions();
    el.focus();
    await sleep(150);
    if (reactControl(el)) {
      self.__jevPress(reactControl(el));
      return visibleOptions();
    }
    el.click();
    const list = await visibleOptions(3);
    if (list.length) return list;
    // Some pickers, such as Material UI's Select and Ant Design's, open on a mouse press rather than a click.
    self.__jevPress(el);
    const pressed = await visibleOptions(4);
    if (pressed.length) return pressed;
    // Others open only from the keyboard, the way a screen-reader user would.
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, bubbles: true, composed: true }));
    return visibleOptions(6);
  }

  function closePicker(el) {
    if (el.tagName === "BUTTON") el.click();
    else el.blur();
  }

  // A picker's choices only exist while it is open, so it is opened, read and closed again.
  async function readOptions(f) {
    if (f.control !== "combobox") return f.options;
    const options = (await openPicker(f.el)).map(textOf);
    closePicker(f.el);
    await sleep(300);
    return options;
  }

  const isChoice = (f) => ["select", "radio", "buttons"].includes(f.control) || f.control === "combobox";

  // For a question with no direct profile answer, JEV makes its best guess from the candidate's facts, so required fields are not left blank.
  async function answerWithJev(todo, threshold) {
    for (const { f, entry, reason, value } of todo) {
      if (Date.now() > deadline) {
        report.skipped.push({ ...entry, reason: "ran out of time" });
        continue;
      }
      if (!isChoice(f)) continue;
      let options = await readOptions(f);
      if (options.length > 40) {
        // JEV sees 40 options at most, so a long list is narrowed to those closest to the known value.
        const words = new Set(norm(value || "").split(/[^a-z0-9]+/).filter((w) => w.length > 2));
        const score = (o) => norm(o).split(/[^a-z0-9]+/).filter((w) => words.has(w)).length;
        options = options.filter((o) => score(o) > 0 || /^other\b/i.test(o)).sort((a, b) => score(b) - score(a)).slice(0, 40);
      }
      // A known value only needs matching to the wording here; otherwise the question itself is answered.
      const ask = value ? { type: "choose", kind: entry.key, term: value, options } : { type: "answer", question: f.label, section: f.section, options };
      let res = options.length ? await chrome.runtime.sendMessage(ask) : null;
      let source = "jev-match";
      if (options.length && (res?.index == null || res.confidence < threshold)) {
        res = await chrome.runtime.sendMessage({ type: "answer", question: f.label, section: f.section, options });
        source = "jev-guess";
      }
      if (res?.index == null) {
        report.skipped.push({ ...entry, reason });
        continue;
      }
      const done = { ...entry, source: value && source === "jev-match" ? source : "jev-guess", confidence: res.confidence, answer: options[res.index] };
      try {
        const why = await fill(f, entry.key, options[res.index]);
        if (why) report.failed.push({ ...done, reason: why });
        else report.filled.push(done);
      } catch (e) {
        report.failed.push({ ...done, reason: String(e) });
      }
    }
  }

  const homePlaces = () => new Set([home.country, ...(home.places || [])].map(norm));

  // Home or abroad, from the question first and then the job's title and location. Null when unclear or mixed.
  function jobRegion(f) {
    if (!home?.country) return null;
    const read = (t) => {
      const places = homePlaces();
      const found = [...(t || "").matchAll(PLACES)].map((m) => norm(m[0]));
      for (const p of places) if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t || "")) found.push(p);
      const atHome = found.some((p) => places.has(p));
      const away = found.some((p) => !places.has(p));
      return atHome === away ? null : atHome ? "home" : "abroad";
    };
    const place = decodeURIComponent(location.pathname).replace(/[-_/]+/g, " ");
    const around = [...document.querySelectorAll('h1, [class*="location" i], [data-qa*="location" i], [class*="job-title" i]')].filter((e) => !e.querySelector("input, select, textarea")).map(textOf);
    return read(f.label) || read([tabTitle, document.title, place, ...around].join(" ")) || postingRegion();
  }

  // The schema.org JobPosting most job boards publish for search engines; its country may be a code such as NL.
  function postingRegion() {
    const countries = [];
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      if (x.addressCountry) countries.push(String(x.addressCountry.name || x.addressCountry));
      Object.values(x).forEach(walk);
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(s.textContent);
        [data, ...(data["@graph"] || [])].filter((d) => d && d["@type"] === "JobPosting").forEach((d) => walk(d.jobLocation));
      } catch {}
    }
    if (!countries.length) return null;
    const names = new Set([...homePlaces(), ...(home.codes || []).map(norm)]);
    const atHome = countries.map((c) => names.has(norm(c)));
    return atHome.every(Boolean) ? "home" : atHome.some(Boolean) ? null : "abroad";
  }

  async function mapAll(fields) {
    const mode = config.mode || "static";
    const out = new Map();
    const needJev = [];
    for (const f of fields) {
      const key = mode === "jev" ? null : self.staticKey(f.label, f.section);
      if (key) out.set(f, { key, confidence: 1, source: "static" });
      else if (mode !== "static") needJev.push(f);
      else out.set(f, { key: "unknown", confidence: 1, source: "static" });
    }
    if (needJev.length) {
      const res = await chrome.runtime.sendMessage({
        type: "map",
        title: document.title,
        fields: needJev.map(({ id, control, label, section, options }) => ({ id, control, label, section, options }))
      });
      if (!res || res.error) {
        report.error = res ? res.error : "the helper did not answer";
      } else {
        report.jev.push({ calls: res.calls, inputTokens: res.inputTokens, model: res.model, ms: res.ms, fields: needJev.length });
        for (const f of needJev) {
          const m = res.mapped[f.id];
          if (m) out.set(f, { ...m, source: "jev" });
        }
      }
    }
    return out;
  }

  // Boxes grouped with a "Relationship" question describe someone else, such as a reference, so they are never given the candidate's details.
  function aboutSomeoneElse(fields) {
    const out = new Set();
    for (const r of fields.filter((f) => /relationship|relation to you|how do you know/i.test(f.label))) {
      let box = r.el.parentElement || r.el;
      while (box.parentElement && fields.filter((f) => box.contains(f.el)).length < 3) box = box.parentElement;
      const inside = fields.filter((f) => box.contains(f.el));
      if (inside.length <= 8 || window !== top) inside.forEach((f) => out.add(f));
    }
    return out;
  }

  // Returns how many fields it looked at, so the caller can stop once nothing new appears.
  async function pass() {
    const fields = collect();
    if (!fields.length) return 0;
    const mapped = await mapAll(fields);
    const threshold = config.threshold ?? 0.9;
    const todo = [];
    const unanswered = [];
    const others = aboutSomeoneElse(fields);
    const leave = (f, entry, reason, value) => (isChoice(f) && entry.key !== "notifications_opt_in" ? unanswered.push({ f, entry, reason, value }) : report.skipped.push({ ...entry, reason }));
    for (const f of fields) {
      let m = mapped.get(f);
      if (f.control === "select" && dialCodes(f.options)) m = { key: "phone_country_code", confidence: 1, source: "static" };
      if (others.has(f) || (m && /_ctc$/.test(m.key) && self.payElsewhere(f.label))) m = { key: "leave_blank", confidence: 1, source: "static" };
      const entry = { id: f.id, label: f.label, control: f.control, key: m?.key ?? null, confidence: m?.confidence ?? null, source: m?.source ?? null };
      if (!m) leave(f, entry, "no answer");
      else if (m.confidence < threshold) leave(f, entry, "low confidence");
      else if (m.key === "unknown") leave(f, entry, "left for the agent");
      else if (NO_FILL.has(m.key)) leave(f, entry, "left for the agent");
      else todo.push({ f, entry });
    }
    const keys = [...new Set(todo.map((t) => t.entry.key).filter((k) => k !== "resume_upload" && k !== "todays_date"))];
    if (keys.includes("phone")) keys.push("phone_with_country_code", "phone_country_code");
    const languageBoxes = fields.filter((f) => f.control === "checkbox" && (!mapped.get(f) || mapped.get(f).key === "unknown" || mapped.get(f).confidence < threshold));
    if (languageBoxes.length) keys.push("spoken_languages");
    const res = keys.length ? await chrome.runtime.sendMessage({ type: "values", keys }) : { values: {} };
    if (!res || res.error) throw new Error(res ? res.error : "the helper did not answer");
    profile = res.values;
    home = res.home || null;
    for (const { f, entry } of todo) {
      if (Date.now() > deadline) {
        report.skipped.push({ ...entry, reason: "ran out of time" });
        continue;
      }
      // How long each field took, published as it goes, so a slow or stuck widget can be found.
      report.timings.push([entry.label.slice(0, 50), Date.now()]);
      publish();
      let value = res.values[entry.key];
      if (entry.key === "todays_date") value = f.control === "date" ? localDate(new Date()) : new Date().toLocaleDateString("en-US");
      if (value && typeof value === "object") {
        const region = jobRegion(f);
        if (!region) {
          leave(f, entry, "job country unclear");
          continue;
        }
        value = value[region];
      }
      if (!value && entry.key !== "resume_upload") {
        leave(f, entry, "no value in the profile");
        continue;
      }
      try {
        const why = await fill(f, entry.key, value);
        if (why === "no matching option" && isChoice(f)) leave(f, entry, why, typeof value === "string" ? value : undefined);
        else if (why) report.failed.push({ ...entry, reason: why });
        else report.filled.push(entry);
      } catch (e) {
        report.failed.push({ ...entry, reason: String(e) });
      }
    }
    // A tick-box list of languages: tick the ones the candidate speaks.
    const spoken = norm(res.values.spoken_languages || "").replace(/\([^)]*\)/g, "").split(/[^a-z]+/).filter(Boolean);
    for (const f of languageBoxes) {
      if (spoken.includes(norm(f.label).split(/[^a-z]+/)[0])) {
        f.el.click();
        if (f.el.checked) report.skipped = report.skipped.filter((s) => s.label !== f.label);
        if (f.el.checked) report.filled.push({ id: f.id, label: f.label, control: f.control, key: "spoken_languages", confidence: 1, source: "static" });
      }
    }
    if (config.mode !== "static") await answerWithJev(unanswered, threshold);
    else unanswered.forEach(({ entry, reason }) => report.skipped.push({ ...entry, reason }));
    return fields.length;
  }

  // One run per click. Repeats only to catch fields revealed by its own answers.
  window.__jevRun = async (title) => {
    tabTitle = title;
    // The helper only serves the page's own site, so a frame from another site (an ad or embed) does not run.
    if (window.top !== window.self) {
      try {
        void window.top.location.href;
      } catch {
        return { filled: 0, left: 0, error: null };
      }
    }
    deadline = Date.now() + 150000;
    seen = new WeakSet();
    resumeAttached = false;
    report = { filled: [], skipped: [], failed: [], jev: [], timings: [], error: null, done: false };
    publish();
    config = await chrome.storage.local.get(["mode", "threshold"]);
    config.mode = config.mode || "static";
    try {
      if (self.__jevWorkdayPresent()) {
        const data = await chrome.runtime.sendMessage({ type: "workday" });
        if (!data || data.error) throw new Error(data ? data.error : "the helper did not answer");
        const done = await self.__jevWorkday(data);
        for (const label of done.filled) report.filled.push({ label, control: "workday" });
        for (const label of done.failed) report.failed.push({ label, control: "workday", reason: "did not hold" });
      }
      for (let i = 0; i < 5 && (await pass()); i++) await sleep(400);
    } catch (e) {
      report.error = String(e.message || e);
    }
    report.done = true;
    publish();
    return { filled: report.filled.length, left: report.skipped.length + report.failed.length, error: report.error };
  };
})();
