// SCAFFOLD — see ../plan.md before extending this file.
//
// Verified against racecenter.lavuelta.es on 2026-08-15 (race starts 2026-08-22,
// so all live testing so far was done against the completed 2024/2025 editions).
// Endpoint shapes and open questions are documented in plan.md — read that first.
async function run(input) {
  const year = resolveYear(input);
  const baseUrl = "https://racecenter.lavuelta.es";

  // Separate regex for checking (no g flag) vs replacing (g flag)
  const HAS_UNSAFE_CHARS = /[<>&"'`]/;
  const UNSAFE_CHAR_REGEX = /[<>&"'`]/g;
  const HTML_ESCAPE_MAP = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    '"': "&quot;",
    "'": "&#39;",
    "`": "&#96;"
  };

  function sanitizeString(value, fallback = "") {
    if (value === null || value === undefined) return fallback;

    const str = String(value).slice(0, 300);

    if (!HAS_UNSAFE_CHARS.test(str)) return str;

    return str.replace(UNSAFE_CHAR_REGEX, (char) => HTML_ESCAPE_MAP[char]);
  }

  async function fetchJson(path) {
    if (
      typeof path !== "string" ||
      !path.startsWith("/api/") ||
      path.includes("..") ||
      path.includes("//") ||
      !/^\/api\/[a-zA-Z0-9/_-]+$/.test(path)
    ) {
      throw new Error("Invalid API path");
    }

    const url = new URL(path, baseUrl);
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; trmnl-vuelta-classification/1.0)" }
    });

    if (res.status === 204) return null;
    if (!res.ok) {
      throw new Error(`Race Center API request failed: ${path}`);
    }

    return await res.json();
  }

  function dateKey(dateString) {
    return String(dateString).slice(0, 10);
  }

  // Pointer fields like "$rider"/"$team" are "{collection}-{year}:{hash}",
  // but the referenced record's own "_id" is just the bare hash — strip the
  // "collection-year:" prefix before using a pointer as a lookup key.
  function pointerId(pointer) {
    if (typeof pointer !== "string") return null;
    const idx = pointer.indexOf(":");
    return idx === -1 ? pointer : pointer.slice(idx + 1);
  }

  // mm:ss for gaps under an hour, h:mm:ss beyond that — raw seconds is
  // unreadable once a GC gap grows past a few minutes.
  function formatGap(ms) {
    if (ms === null || ms === undefined || ms <= 0) return null;

    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");

    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  function todayMadridKey() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Madrid",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date());

    return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}-${parts.find((p) => p.type === "day").value}`;
  }

  // TRMNL's docs don't pin down exactly where custom field selections land on
  // the transform input, so check the shapes seen in practice rather than
  // assuming one (same approach as the sibling "Stages" plugin).
  function customField(keyname, fallback) {
    const sources = [
      input?.custom_fields,
      input?.custom_fields_values,
      input?.trmnl?.plugin_settings?.custom_fields_values,
      input?.trmnl?.custom_fields_values
    ];

    for (const source of sources) {
      if (source && typeof source === "object" && source[keyname]) {
        return source[keyname];
      }
    }

    return fallback;
  }

  // "Season" custom field lets a user browse a past year's final GC/stage
  // winners before the current race starts (or after it's over) — pulls the
  // first 4-digit number out of the selected option ("Current (2026)", "2024",
  // etc.) rather than matching the label text exactly.
  function resolveYear() {
    const raw = String(customField("classification_year", "2025"));
    const match = raw.match(/\d{4}/);
    return match ? Number(match[0]) : 2025;
  }

  // --- Stage list: used only to figure out which stage number is the most
  // recently completed one (or null pre-race). Same endpoint the sibling
  // "Stages" plugin polls; always populated regardless of race status.
  const stagesRaw = await fetchJson(`/api/stage-${year}`);
  const stages = stagesRaw
    .filter((stage) => stage && stage.stage && stage.date)
    .sort((a, b) => Number(a.stage) - Number(b.stage));

  const currentDateKey = todayMadridKey();
  const completedStages = stages.filter((s) => dateKey(s.date) < currentDateKey);
  const lastCompletedStage = completedStages.length
    ? completedStages[completedStages.length - 1]
    : null;

  // TODO(plan.md "Open questions"): once the race is live, confirm whether
  // rankingType-{year}-{n} for the *in-progress* stage 404s/204s cleanly, or
  // whether it needs the previousStageFallback-style "-1" the SPA does. For
  // now this only ever asks for a stage that's already finished.
  const stageNumber = lastCompletedStage ? Number(lastCompletedStage.stage) : null;

  let gc = [];
  let stageResult = [];
  let riderById = new Map();
  let teamById = new Map();

  if (stageNumber !== null) {
    try {
      // --- Rider/team lookup tables. Rankings below reference riders only by
      // bib number or by a "$rider": "allCompetitors-{year}:{hash}" pointer —
      // there is no embedded name/team on the ranking rows themselves.
      const [competitorsRaw, teamsRaw] = await Promise.all([
        fetchJson(`/api/allCompetitors-${year}`),
        fetchJson(`/api/team-${year}`)
      ]);

      for (const t of teamsRaw || []) {
        if (t && t._id) teamById.set(t._id, t);
      }

      riderById = new Map(
        (competitorsRaw || []).map((c) => [
          c._id,
          {
            bib: c.bib,
            name: sanitizeString(`${c.firstname || ""} ${c.lastname || ""}`.trim()),
            team: sanitizeString(
              teamById.get(pointerId(c.$team))?.nameShort || teamById.get(pointerId(c.$team))?.name
            )
          }
        ])
      );

      // --- General classification as of the last completed stage.
      // CONFIRMED: "itg" (Individual Time General) is the real cumulative GC
      // — verified against 2024 stages 5/10/15/21, where it's present at
      // every stage with a near-full field and gaps that grow monotonically
      // over the race. "icg" (also observed, only on some stages) is an
      // unrelated single-rider intermediate-checkpoint snapshot, not the GC
      // — see plan.md for the raw samples. Do not add "icg" back to this
      // filter.
      const rankingRaw = await fetchJson(`/api/rankingType-${year}-${stageNumber}`);
      const gcSnapshot = (Array.isArray(rankingRaw) ? rankingRaw : []).find((r) => r?.type === "itg");

      gc = (gcSnapshot?.rankings || []).slice(0, 10).map((r) => {
        const rider = riderById.get(pointerId(r.$rider)) || {};
        return {
          position: r.position,
          bib: r.bib,
          name: rider.name || `Bib ${r.bib}`,
          team: rider.team || "",
          // `absolute`/`relative` are milliseconds on this API, not seconds.
          gapMs: r.relative ?? null,
          gap: formatGap(r.relative)
        };
      });

      // --- Most recent stage result (the "who won stage N" data the sibling
      // plugin doesn't surface). Separate endpoint from the GC one above.
      const arrivalRaw = await fetchJson(`/api/rankingTypeArrival-${year}-${stageNumber}`);
      const arrivalSnapshot = Array.isArray(arrivalRaw) ? arrivalRaw[0] : null;

      stageResult = (arrivalSnapshot?.rankings || []).slice(0, 5).map((r) => {
        const rider = riderById.get(pointerId(r.$rider)) || {};
        return {
          position: r.position,
          bib: r.bib,
          name: rider.name || `Bib ${r.bib}`,
          team: rider.team || "",
          gapMs: r.relative ?? null,
          gap: formatGap(r.relative)
        };
      });
    } catch (error) {
      gc = [];
      stageResult = [];
    }
  }

  // TODO: jersey classifications (points/mountains/youth) via
  // /api/rankingTypeJerseys-{year}-{stageNumber}, filtered by jersey `type`
  // code. Only "pmt" has been observed so far — see plan.md before wiring
  // this up as a real custom_fields option.

  return {
    year: String(year),
    mode: stageNumber === null ? "before_race" : "during_or_after_race",
    lastCompletedStage: lastCompletedStage
      ? { number: Number(lastCompletedStage.stage), date: lastCompletedStage.date }
      : null,
    gc,
    stageResult,

    vueltaLogo: "https://www.lavuelta.es/img/global/logo-reversed@2x.png",

    debug: {
      currentDateKey,
      stageNumber,
      gcCount: gc.length,
      stageResultCount: stageResult.length,
      riderCount: riderById.size,
      teamCount: teamById.size
    }
  };
}
