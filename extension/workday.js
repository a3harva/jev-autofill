// Fills Workday's repeating My Experience blocks, which need their own rows, search pickers and date boxes.
(() => {
  const SECTIONS = ["Work-Experience-section", "Education-section", "Certifications-section", "Skills-section", "Websites-section"];
  const DEGREES = { "bachelor of technology": ["Bachelor of Technology", "Bachelors of Engineering", "Bachelor of Engineering"] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const letters = (s) => (s || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const shown = (e) => e.getBoundingClientRect().width > 0;
  const group = (id) => document.querySelector(`[aria-labelledby="${id}"]`);
  const byId = (id) => document.getElementById(id);

  function press(el) {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    for (const t of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, at));
    }
  }

  self.__jevPress = press;

  function enter(el, value, change = true) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    if (change) el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function text(el, value) {
    if (!el || el.value || !value) return false;
    el.focus();
    enter(el, value);
    el.blur();
    return el.value === value;
  }

  // Year first: a month entered while the year is empty gets dropped. Month goes in without a leading zero.
  async function date(row, name, value) {
    const [month, year] = value.split("/");
    const m = byId(`${row}--${name}-dateSectionMonth-input`);
    const y = byId(`${row}--${name}-dateSectionYear-input`);
    if (!m || !y) return false;
    if (m.value && y.value) return true;
    for (const [el, v] of [[y, year], [m, String(+month)]]) {
      if (el.value) continue;
      el.focus();
      enter(el, v, false);
      await sleep(200);
      el.blur();
      await sleep(300);
    }
    return Boolean(m.value && y.value);
  }

  const best = (nodes, term, exact) => {
    const want = letters(term);
    return nodes.find((n) => letters(n.innerText) === want) || (exact ? undefined : nodes.filter((n) => letters(n.innerText).includes(want)).sort((a, b) => a.innerText.length - b.innerText.length)[0]);
  };

  function options() {
    const leaves = [...document.querySelectorAll('[data-automation-id="promptLeafNode"]')].filter(shown);
    return leaves.length ? leaves : [...document.querySelectorAll('[data-automation-id="activeListContainer"] [data-automation-id="menuItem"]')].filter(shown);
  }

  // Asks JEV which result means the same as the term. Only a confident answer counts.
  async function askJev(kind, term) {
    const list = options().slice(0, 40);
    if (!list.length) return undefined;
    const res = await chrome.runtime.sendMessage({ type: "choose", kind, term, options: list.map((n) => n.innerText.trim()) });
    return res && res.index != null && res.confidence >= 0.9 ? list[res.index] : undefined;
  }

  // Searches a picker and chooses a matching result. Leaves it empty when nothing matches.
  async function pick(input, terms, exact, kind) {
    const field = input.closest('[data-automation-id^="formField"]');
    const chips = () => field.querySelectorAll('[aria-label*="press delete"]').length;
    const before = chips();
    for (const term of terms) {
      input.scrollIntoView({ block: "center" });
      input.focus();
      input.click();
      await sleep(400);
      enter(input, term, false);
      await sleep(600);
      for (const t of ["keydown", "keypress", "keyup"]) input.dispatchEvent(new KeyboardEvent(t, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      await sleep(1000);
      let hit;
      let last = "";
      for (let i = 0; i < 16 && !hit; i++) {
        await sleep(250);
        const seen = options().map((n) => n.innerText).join("|");
        hit = best(options(), term, exact);
        if (seen && seen === last) break;
        last = seen;
      }
      hit = hit || (await askJev(kind, term));
      if (hit) {
        hit.scrollIntoView({ block: "nearest" });
        await sleep(150);
        press(hit);
        await sleep(900);
        if (chips() > before) return true;
      }
      enter(input, "", false);
      await sleep(200);
    }
    input.blur();
    return false;
  }

  async function dropdown(button, labels) {
    button.scrollIntoView({ block: "center" });
    button.click();
    await sleep(1200);
    const list = [...document.querySelectorAll('[role="option"]')].filter(shown);
    for (const l of labels) {
      const hit = list.find((o) => letters(o.innerText) === letters(l));
      if (hit) {
        hit.scrollIntoView({ block: "nearest" });
        await sleep(150);
        press(hit);
        await sleep(600);
        return letters(button.innerText) === letters(l);
      }
    }
    button.click();
    return false;
  }

  const rows = (prefix, tail) => [...document.querySelectorAll(`[id^="${prefix}-"][id$="--${tail}"]`)].map((e) => e.id.slice(0, -`--${tail}`.length));

  async function addRow(section, prefix, tail) {
    const before = new Set(rows(prefix, tail));
    group(section).querySelector('[data-automation-id="add-button"]').click();
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      const fresh = rows(prefix, tail).find((r) => !before.has(r));
      if (fresh) return fresh;
    }
    throw new Error(`no new row appeared in ${section}`);
  }

  // Runs one fill, recording its label as filled or failed.
  async function step(out, label, fn) {
    try {
      out[(await fn()) ? "filled" : "failed"].push(label);
    } catch (e) {
      out.failed.push(`${label}: ${e.message || e}`);
    }
  }

  self.__jevWorkdayHandles = (el) => SECTIONS.some((s) => el.closest(`[aria-labelledby="${s}"]`));
  self.__jevWorkdayPresent = () => Boolean(group("Work-Experience-section"));

  // Existing values are kept: a job already listed only has its blank boxes filled.
  self.__jevWorkday = async (data) => {
    const out = { filled: [], failed: [] };
    for (const job of data.work_history || []) {
      const all = rows("workExperience", "jobTitle");
      const row = all.find((r) => letters(byId(`${r}--jobTitle`).value) === letters(job.title)) || all.find((r) => !byId(`${r}--jobTitle`).value && !byId(`${r}--companyName`).value) || (await addRow("Work-Experience-section", "workExperience", "jobTitle"));
      const fill = async (name, value) => {
        const el = byId(`${row}--${name}`);
        if (el && !el.value && value) await step(out, `${job.title}: ${name}`, () => text(el, value));
      };
      await fill("jobTitle", job.title);
      await fill("companyName", job.company);
      await fill("location", job.location);
      await fill("roleDescription", job.description);
      await step(out, `${job.title}: from`, () => date(row, "startDate", job.from));
      if (job.to) await step(out, `${job.title}: to`, () => date(row, "endDate", job.to));
      else
        await step(out, `${job.title}: currently work here`, async () => {
          const box = byId(`${row}--currentlyWorkHere`);
          if (!box.checked) box.click();
          await sleep(300);
          return box.checked;
        });
    }

    if (group("Education-section") && data.school) {
      const row = rows("education", "school")[0] || (await addRow("Education-section", "education", "school"));
      const school = byId(`${row}--school`);
      const field = school.closest('[data-automation-id^="formField"]');
      if (!field.querySelector('[aria-label*="press delete"]')) await step(out, "school", () => pick(school, [data.school.split(/[(,]/)[0].trim()], false, "college"));
      const degree = byId(`${row}--degree`);
      if (degree && /select one/i.test(degree.innerText)) await step(out, "degree", () => dropdown(degree, DEGREES[data.degree.toLowerCase()] || [data.degree]));
      const study = byId(`${row}--fieldOfStudy`);
      if (study && data.major && !study.closest('[data-automation-id^="formField"]').querySelector('[aria-label*="press delete"]')) await step(out, "field of study", () => pick(study, [data.major, data.major.split("&")[0].trim()], false, "field of study"));
    }

    const skills = byId("skills--skills");
    if (skills && data.skills) {
      const chosen = () => [...skills.closest('[data-automation-id^="formField"]').querySelectorAll('[aria-label*="press delete"]')].map((e) => letters(e.getAttribute("aria-label")));
      for (const s of data.skills.split(",").map((x) => x.trim()).filter(Boolean)) {
        if (!chosen().some((c) => c.includes(letters(s)))) await step(out, `skill: ${s}`, () => pick(skills, [s], true, "skill"));
      }
    }

    if (group("Websites-section") && data.website_url) {
      const urls = rows("webAddress", "url");
      if (!urls.some((r) => byId(`${r}--url`).value)) {
        const row = urls[0] || (await addRow("Websites-section", "webAddress", "url"));
        await step(out, "website", () => text(byId(`${row}--url`), data.website_url));
      }
    }
    return out;
  };
})();
