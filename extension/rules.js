// Static field mapping: the first rule whose pattern matches the field's question wins.
(() => {
  const EDU = /educat|school|academic|qualification/i;
  const OTHER_PERSON = /\b(reference|referee|manager|supervisor|emergency|next of kin|guardian|spouse)\b/i;
  const RULES = [
    // Workday's "Given Name (Local)" etc. are for names in a local script; filling them duplicates the name (2026-11-21).
    [/\blocal\b.*\bname\b|\bname\b.*\blocal\b/, "leave_blank"],
    // "Phone Extension" is not the phone number.
    [/\bextension\b|\bext\b\.?$|phone ext/, "leave_blank"],
    // Address lines 2-3, door/flat numbers: the whole address goes in line 1, so these stay empty instead of repeating it.
    [/address( line)? ?(2|3|two|three)\b|\bline ?(2|3)\b|door|flat no|house no|apartment|suite|building name/, "leave_blank"],
    [/(do|does) you (have|hold|possess)( a| an)? (bachelor|undergraduate|graduate degree|degree)|bachelor'?s? degree\??$|completed (a |your )?(bachelor|graduation|degree)/, "has_bachelors_degree"],
    [/portfolio/, "website_url"],
    [/^(today'?s )?date$/, "todays_date"],
    [/cover letter/, "leave_blank"],
    [/\b(resume|cv)\b/, "resume_upload"],
    [/sponsor|visa (status|situation|requirement)/, "requires_sponsorship"],
    [/authori[sz]ed to work|eligible to work|right to work/, "authorized_to_work"],
    [/\bpan\b/, "pan_number"],
    [/aadha?ar/, "aadhaar_number"],
    [/passport/, "passport_number"],
    [/bank|ifsc/, "bank_account"],
    [/password/, "password"],
    [/10th|ssc|tenth/, null, (q) => (/year/.test(q) ? "tenth_passing_year" : "tenth_percentage")],
    [/12th|hsc|twelfth/, null, (q) => (/year/.test(q) ? "twelfth_passing_year" : "twelfth_percentage")],
    [/python/, "years_python"],
    [/genai|generative|\bllm/, "years_genai"],
    [/agentic|langgraph/, "years_agentic"],
    [/\brag\b|vector/, "years_rag"],
    [/kubernetes|\bgke\b/, "years_kubernetes"],
    [/fastapi/, "years_fastapi"],
    [/\baws\b/, "years_aws"],
    [/\bcloud\b.*(year|experience)|(year|experience).*\bcloud\b/, "years_cloud"],
    [/offer.*(ctc|salary|package)|(ctc|salary|package).*offer/, "offered_ctc"],
    // "At what annual CTC would you be comfortable joining?" asks for the expected figure too (WIN on Greenhouse, 2026-11-23).
    [/expected.*(ctc|salary|compensation|pay)|desired (salary|pay|compensation|ctc)|salary (expectation|requirement)|(ctc|salary|compensation|package)\b.*\b(join|accept|comfortable)|\b(join|accept|comfortable)\b.*(ctc|salary|compensation|package)/, "expected_ctc"],
    [/\bctc\b|current (salary|compensation)/, "current_ctc"],
    [/offer in hand|another offer|other offer/, "offer_in_hand"],
    [/notice period|available to join|days to join|joining (time|period)/, "notice_period_days"],
    [/immediate/, "immediate_joiner"],
    [/night shift|us hours/, "night_shift"],
    [/father/, "fathers_name"],
    [/marital/, "marital_status"],
    [/date of birth|\bdob\b/, "date_of_birth"],
    [/pronoun/, "pronouns"],
    [/ethnic|\brace\b/, "ethnicity"],
    [/veteran/, "veteran_status"],
    [/disabilit/, "disability_status"],
    [/gender/, "gender"],
    [/^(your )?((current|most recent|present) )?(company|employer|organi[sz]ation)( name)?$|^(current|present) (company|employer)/, "current_company"],
    [/^(job |current |present )(title|designation)$|^designation$|current (job )?title|current designation/, "current_title"],
    [/first name|given name/, "first_name"],
    [/last name|surname|family name/, "last_name"],
    [/preferred name|nickname|call you/, "preferred_name"],
    [/full name|^name$|your name/, "full_name"],
    [/e-?mail/, "email"],
    [/(phone|mobile).*(country code|international)/, "phone_with_country_code"],
    [/country code|dialing code/, "phone_country_code"],
    [/phone|mobile|contact number/, "phone"],
    [/linkedin/, "linkedin_url"],
    [/github/, "github_url"],
    [/portfolio|website|personal site/, "website_url"],
    [/mailing address|full address/, "full_address"],
    [/street|address/, "address_line1"],
    [/preferred.*(location|city)|desired location/, "preferred_location"],
    [/relocat/, "willing_to_relocate"],
    [/work type|employment type|job type/, "employment_type"],
    [/(happy|willing|comfortable|able|open|ok|okay) (to |with )?(work(ing)?|com(e|ing)|commut(e|ing))( \S+){0,5} (office|on-?site)|work(ing)? (from|in|at) (the |our )?office/, "willing_to_work_onsite"],
    // "Which city and state will you live in while working remotely?" asks where, not how (WIN on Greenhouse, 2026-11-23).
    [/(which|what) (city|town)\b.*\b(live|living|reside|based)|city (and|&) state/, "current_location"],
    [/work mode|remote|hybrid|on-?site/, "remote_preference"],
    [/^country( of residence)?$|what country|which country/, "country"],
    [/based|current location|^location$/, "current_location"],
    [/\bcity\b/, "city"],
    [/\bstate\b|province/, "state_province"],
    [/postal|zip|\bpin\b|pin ?code/, "postal_code"],
    [/citizen|nationality/, "citizenship"],
    [/^country$/, "country"],
    [/university|college|alma mater|institute/, "school"],
    [/highest (qualification|education)/, "education_level"],
    [/\bdegree\b/, "degree"],
    [/major|field of study|branch/, "major"],
    [/graduation year|passing year|year of passing/, "graduation_year"],
    [/gpa|cgpa/, "gpa"],
    [/total experience|years of ((full-time|full time|work|working|professional|relevant|overall|total|industry|it) )*experience|^(total |overall |work )?experience( in years)?$|experience in years/, "years_of_experience"],
    [/skills/, "skills"],
    [/previously (applied|worked)|worked (here|at this|for this)/, "previously_applied"],
    [/felony|convicted/, "felony"],
    [/non-?compete/, "non_compete"],
    [/background check/, "background_check"],
    [/drug test/, "drug_test"],
    [/driver/, "drivers_license"],
    [/18 years|over 18/, "over_18"],
    [/languages/, "spoken_languages"],
    [/when can you start|earliest start|available start|availability/, "earliest_start_date"],
    [/how (did |do )?you (first )?(hear|heard|found|find|get to know|come to know|learn)|where did you (first )?(hear|find|see)/, "how_did_you_hear"],
    [/\breferred|referral/, "referral_name"],
    [/job alert|newsletter|marketing|share my|partners/, "notifications_opt_in"],
    [/i agree|privacy|terms|consent/, "consent_yes"],
    [/why do you|describe|tell us|anything else/, "free_text"]
  ];

  // Pay is kept in yearly lakhs of rupees, so a question in another currency or per month is left for the agent.
  self.payElsewhere = (label) =>
    /\b(eur|usd|gbp|aud|cad|sgd|chf|idr|aed|myr|php|jpy|cny|nzd|zar|sar|qar|hkd|krw|thb|vnd)\b|[$€£¥]|dollar|euro|pound|rupiah|dirham|month|per hour|hourly/i.test(label || "");

  self.staticKey = (label, section) => {
    // Accents (résumé), required markers and trailing punctuation are not part of the question.
    const q = (label || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\((required|optional|mandatory)\)/g, " ").replace(/[*✱:?]+/g, " ").replace(/\s+/g, " ").trim();
    if (OTHER_PERSON.test(q) && /e-?mail|phone|mobile|contact|name/.test(q)) return "leave_blank";
    if (OTHER_PERSON.test(section || "") && /e-?mail|phone|mobile|contact|name|title|company|relationship/.test(q)) return "leave_blank";
    // A bare "Title" is a job title only inside a work-history block; elsewhere it may name a certificate or a salutation.
    if (q === "title") return /employ|experience|work|job|position|career/i.test(section || "") ? "current_title" : null;
    if (EDU.test(section || "")) {
      if (/^start/.test(q)) return "education_start_date";
      if (/^end/.test(q)) return "graduation_date";
    }
    for (const [re, key, fn] of RULES) {
      // A skill's name alone is not a question about years: it can be an essay prompt that mentions it.
      if (!re.test(q) || (key && key.startsWith("years_") && !/year|experience/.test(q))) continue;
      if (/_ctc$/.test(key || "") && self.payElsewhere(q)) return "leave_blank";
      return key || fn(q);
    }
    return null;
  };
})();
