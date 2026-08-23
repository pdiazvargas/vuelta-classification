// Verified against racecenter.lavuelta.es on 2026-08-15 (race starts 2026-08-22,
// so all live testing so far was done against the completed 2024/2025 editions).
async function run(input) {
  const year = resolveYear();
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

  function todayKeyIn(timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
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

  // "Season" custom field lets a user browse a past year's race, replayed
  // day-by-day (see the stage-resolution branch below), before the current
  // race starts or after it's over — pulls the first 4-digit number out of
  // the selected option ("Current (2026)", "2024", etc.) rather than
  // matching the label text exactly.
  function resolveYear() {
    const raw = String(customField("classification_year", "2025"));
    const match = raw.match(/\d{4}/);
    return match ? Number(match[0]) : 2025;
  }

  // Same field/logic as the sibling "Stages" plugin, so "today" agrees
  // between the two rather than one plugin rolling to the next day hours
  // before the other.
  function resolveDisplayTimeZone() {
    const raw = String(customField("display_timezone", "CEST"));
    return /eastern/i.test(raw) ? "America/New_York" : "Europe/Madrid";
  }

  // --- Stage list: used only to figure out which stage number to show (or
  // null pre-race). Same endpoint the sibling "Stages" plugin polls; always
  // populated regardless of race status.
  const stagesRaw = await fetchJson(`/api/stage-${year}`);
  const stages = stagesRaw
    .filter((stage) => stage && stage.stage && stage.date)
    .sort((a, b) => Number(a.stage) - Number(b.stage));

  const currentDateKey = todayKeyIn(resolveDisplayTimeZone());
  const currentYear = Number(currentDateKey.slice(0, 4));
  const currentDay = Number(currentDateKey.slice(8, 10));

  let lastCompletedStage = null;

  if (year === currentYear) {
    // Live/current season — resolve the most recently completed stage by
    // comparing each stage's real date against today.
    const completedStages = stages.filter((s) => dateKey(s.date) < currentDateKey);
    lastCompletedStage = completedStages.length
      ? completedStages[completedStages.length - 1]
      : null;
  } else if (stages.length > 0) {
    // Past, fully-completed season — "replay" mode. Cycle through that
    // season's stages using today's day-of-month as the stage number (day 1
    // = stage 1, ... day 21 = stage 21, day 22 wraps back to stage 1, etc.),
    // ignoring that season's own real stage dates entirely — the goal is a
    // day-by-day replay keyed to today's calendar day, not a historical replay.
    const totalStages = stages.length;
    const replayStageNumber = ((currentDay - 1) % totalStages) + 1;
    const replayStage =
      stages.find((s) => Number(s.stage) === replayStageNumber) ||
      stages[(currentDay - 1) % totalStages];
    // Swap in today's date so the title bar reads "as of today" instead of
    // that stage's real historical date from the past season.
    lastCompletedStage = { ...replayStage, date: currentDateKey };
  }

  const stageNumber = lastCompletedStage ? Number(lastCompletedStage.stage) : null;

  let gc = [];
  let stageResult = [];

  if (stageNumber !== null) {
    try {
      // --- Rider/team lookup tables. Rankings below reference riders only by
      // bib number or by a "$rider": "allCompetitors-{year}:{hash}" pointer —
      // there is no embedded name/team on the ranking rows themselves. None of
      // these four fetches depend on each other's results, so they all run
      // concurrently.
      const [competitorsRaw, teamsRaw, rankingRaw, arrivalRaw] = await Promise.all([
        fetchJson(`/api/allCompetitors-${year}`),
        fetchJson(`/api/team-${year}`),
        fetchJson(`/api/rankingType-${year}-${stageNumber}`),
        fetchJson(`/api/rankingTypeArrival-${year}-${stageNumber}`)
      ]);

      const teamById = new Map();
      for (const t of teamsRaw || []) {
        if (t && t._id) teamById.set(t._id, t);
      }

      // Raw fields only — sanitized lazily in mapRankingRow, for just the
      // handful of riders (<=11) that actually end up on a rendered row,
      // instead of eagerly for the whole ~150-200 rider field.
      const riderById = new Map(
        (competitorsRaw || []).map((c) => [
          c._id,
          {
            firstname: c.firstname,
            lastname: c.lastname,
            team: teamById.get(pointerId(c.$team))?.nameShort || teamById.get(pointerId(c.$team))?.name,
            // ASO's own image CDN — used for the stage-winner headshots.
            photo: c.profile_sm || c.profile || ""
          }
        ])
      );

      function mapRankingRow(r, { includePhoto = false } = {}) {
        const rider = riderById.get(pointerId(r.$rider)) || {};
        const fullName = `${rider.firstname || ""} ${rider.lastname || ""}`.trim();
        const row = {
          position: r.position,
          name: fullName ? sanitizeString(fullName) : `Bib ${r.bib}`,
          team: sanitizeString(rider.team),
          gap: formatGap(r.relative)
        };
        if (includePhoto) row.photo = sanitizeString(rider.photo);
        return row;
      }

      // --- General classification as of the last completed stage.
      // CONFIRMED: "itg" (Individual Time General) is the real cumulative GC
      // — verified against 2024 stages 5/10/15/21, where it's present at
      // every stage with a near-full field and gaps that grow monotonically
      // over the race. "icg" (also observed, only on some stages) is an
      // unrelated single-rider intermediate-checkpoint snapshot, not the GC.
      // Do not add "icg" back to this filter.
      const gcSnapshot = (Array.isArray(rankingRaw) ? rankingRaw : []).find((r) => r?.type === "itg");
      // Sliced to 8 — the largest consumer (full.liquid) only renders 8 rows.
      gc = (gcSnapshot?.rankings || []).slice(0, 8).map((r) => mapRankingRow(r));

      // --- Most recent stage result (the "who won stage N" data the sibling
      // plugin doesn't surface). Separate endpoint from the GC one above.
      const arrivalSnapshot = Array.isArray(arrivalRaw) ? arrivalRaw[0] : null;
      // Sliced to 3 — the largest consumer only renders the top 3.
      stageResult = (arrivalSnapshot?.rankings || [])
        .slice(0, 3)
        .map((r) => mapRankingRow(r, { includePhoto: true }));
    } catch (error) {
      gc = [];
      stageResult = [];
    }
  }

  return {
    lastCompletedStage: lastCompletedStage
      ? { number: Number(lastCompletedStage.stage), date: lastCompletedStage.date }
      : null,
    gc,
    stageResult
  };
}
