const MODULE_ID = "curse-of-death-and-despair";
const SOCKET_NAME = `module.${MODULE_ID}`;
const ICON_PATH = `modules/${MODULE_ID}/assets/curse.svg`;
const SC_DATE_TIME_HOOK = "simple-calendar-date-time-change";
const SC_READY_HOOK = "simple-calendar-ready";
const SC_PRIMARY_GM_HOOK = "simple-calendar-primary-gm";
const MAX_MISSED_CYCLES = 20;
const RULES_JOURNAL_FLAG = "rulesJournal";
const RULES_PAGE_FLAG = "rulesPage";
const PALADIN_SELF_AURA_LEVEL = 6;
const DEFAULT_QUICK_ACCESS_STATE = Object.freeze({
  left: 82,
  top: 105,
  locked: true
});
const RECORD_SHARE_FIELDS = Object.freeze([
  "totals",
  "criticals",
  "paladin",
  "rolls",
  "abilities",
  "losses"
]);

const ABILITY_BY_D6 = Object.freeze({
  1: "str",
  2: "dex",
  3: "con",
  4: "int",
  5: "wis",
  6: "cha"
});

const ROLL_MODE_LABELS = Object.freeze({
  publicroll: "RollMode.Public",
  gmroll: "RollMode.Private",
  blindroll: "RollMode.Blind",
  selfroll: "RollMode.Self"
});

let calendarProcessing = false;
let calendarHooksRegistered = false;
let journalUpdateTimer = null;
let configurationApplication = null;
let recordsApplication = null;
let suppressGlobalIntervalReset = false;

function localize(key) {
  return game.i18n.localize(`CODD.${key}`);
}

function format(key, data = {}) {
  return game.i18n.format(`CODD.${key}`, data);
}

function escapeHtml(value) {
  const text = String(value ?? "");
  if (foundry.utils.escapeHTML) return foundry.utils.escapeHTML(text);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isFiniteValue(value) {
  return value !== null
    && value !== undefined
    && value !== ""
    && Number.isFinite(Number(value));
}

function getSimpleCalendar() {
  return globalThis.SimpleCalendar ?? null;
}

function isPrimaryGM() {
  if (!game.user?.isGM) return false;

  const simpleCalendar = getSimpleCalendar();
  try {
    if (simpleCalendar?.api?.isPrimaryGM) {
      return Boolean(simpleCalendar.api.isPrimaryGM());
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not query the Simple Calendar primary GM.`, error);
  }

  const activeGMs = game.users
    .filter((user) => user.active && user.isGM)
    .sort((a, b) => a.id.localeCompare(b.id));
  return activeGMs[0]?.id === game.user.id;
}

function canControlActor(actor, user = game.user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  return actor.testUserPermission(
    user,
    CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER
  );
}

function getSelectedVictimIds() {
  const value = game.settings.get(MODULE_ID, "victimActorIds");
  return Array.isArray(value) ? value : [];
}

function getSelectedVictims() {
  return getSelectedVictimIds()
    .map((id) => game.actors.get(id))
    .filter(Boolean);
}

function getConfigurableActors() {
  const worldActors = Array.isArray(game.actors?.contents)
    ? game.actors.contents
    : Array.from(game.actors ?? []);
  const supportedActors = worldActors.filter(
    (actor) => actor?.type === "character" || actor?.type === "npc"
  );

  // The fallback keeps the configuration usable with custom actor subtypes.
  return supportedActors.length ? supportedActors : worldActors;
}

function isPaladinActor(actor) {
  return getPaladinLevel(actor) > 0;
}

function isPaladinClassItem(item) {
  if (item?.type !== "class") return false;
  const identifier = String(item.system?.identifier ?? "").toLowerCase();
  const name = String(item.name ?? "").toLowerCase();
  return identifier === "paladin"
    || name.includes("paladin")
    || name.includes("paladyn");
}

function getPaladinLevel(actor) {
  return (actor?.items ?? []).reduce((total, item) => {
    if (!isPaladinClassItem(item)) return total;
    const levels = Number(item.system?.levels ?? item.system?.level ?? 0);
    return total + (Number.isFinite(levels) ? Math.max(0, levels) : 0);
  }, 0);
}

function hasSelfAura(actor) {
  return getPaladinLevel(actor) >= PALADIN_SELF_AURA_LEVEL;
}

function getActorAuraDetails(actor) {
  if (actor && hasSelfAura(actor)) {
    const charismaModifier = Number(actor.system?.abilities?.cha?.mod ?? 0);
    return {
      bonus: Math.max(1, charismaModifier),
      source: actor.name,
      actorId: actor.id
    };
  }
  return null;
}

function getConfiguredPaladin() {
  const configuredId = game.settings.get(MODULE_ID, "paladinActorId");
  const configured = configuredId ? game.actors.get(configuredId) : null;
  if (configured) return configured;

  return game.actors
    .filter((actor) => actor.type === "character" && isPaladinActor(actor))
    .sort((a, b) => {
      const aMod = Number(a.system?.abilities?.cha?.mod ?? -99);
      const bMod = Number(b.system?.abilities?.cha?.mod ?? -99);
      return bMod - aMod || a.name.localeCompare(b.name);
    })[0] ?? null;
}

function getAuraDetails() {
  const paladin = getConfiguredPaladin();
  if (paladin) {
    const charismaModifier = Number(paladin.system?.abilities?.cha?.mod ?? 0);
    return {
      bonus: Math.max(1, charismaModifier),
      source: paladin.name,
      actorId: paladin.id
    };
  }

  return {
    bonus: Math.max(0, Number(game.settings.get(MODULE_ID, "fallbackAuraBonus")) || 0),
    source: localize("Aura.Fallback"),
    actorId: null
  };
}

function getAbilityLabel(abilityId) {
  const label = CONFIG.DND5E.abilities?.[abilityId]?.label ?? abilityId;
  return game.i18n.localize(label);
}

function getRollModeForActor(actor) {
  if (actor?.type === "npc") return "blindroll";
  const victimModes = getVictimRollModes();
  const actorMode = String(victimModes[actor?.id] ?? "");
  if (Object.hasOwn(ROLL_MODE_LABELS, actorMode)) return actorMode;
  const configured = String(game.settings.get(MODULE_ID, "rollMode") || "publicroll");
  return Object.hasOwn(ROLL_MODE_LABELS, configured) ? configured : "publicroll";
}

function getRollModeLabel(mode) {
  return localize(ROLL_MODE_LABELS[mode] ?? ROLL_MODE_LABELS.publicroll);
}

function getVictimRollModes() {
  const value = game.settings.get(MODULE_ID, "victimRollModes");
  return value && typeof value === "object" && !Array.isArray(value)
    ? foundry.utils.deepClone(value)
    : {};
}

function getCurseRecords() {
  const value = game.settings.get(MODULE_ID, "victimRecords");
  return value && typeof value === "object" && !Array.isArray(value)
    ? foundry.utils.deepClone(value)
    : {};
}

function getRecordShares() {
  const value = game.settings.get(MODULE_ID, "victimRecordShares");
  return value && typeof value === "object" && !Array.isArray(value)
    ? foundry.utils.deepClone(value)
    : {};
}

function emptyRecordSummary() {
  return {
    attacks: 0,
    saves: 0,
    successes: 0,
    naturalOnes: 0,
    naturalTwenties: 0,
    paladinNearby: 0
  };
}

function normalizeRecordSummary(summary = {}) {
  const normalized = emptyRecordSummary();
  for (const key of Object.keys(normalized)) {
    normalized[key] = Math.max(0, Math.floor(Number(summary[key]) || 0));
  }
  return normalized;
}

function normalizeVictimRecord(actorId, source = {}) {
  return {
    version: 1,
    actorId,
    summary: normalizeRecordSummary(source.summary),
    entries: Array.isArray(source.entries)
      ? source.entries.map((entry) => ({ ...entry }))
      : []
  };
}

function createRecordId() {
  if (typeof foundry.utils.randomID === "function") return foundry.utils.randomID();
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function recordAttackDetermination(data) {
  if (!isPrimaryGM()) return;

  const records = getCurseRecords();
  const victimRecord = normalizeVictimRecord(data.actorId, records[data.actorId]);
  let entry = data.recordId
    ? victimRecord.entries.find((candidate) => candidate.id === data.recordId)
    : null;

  if (!entry) {
    data.recordId = createRecordId();
    entry = {
      id: data.recordId,
      messageId: data.messageId ?? "",
      scheduledTimestamp: Number(data.scheduledTimestamp) || 0,
      startedAt: Date.now()
    };
    victimRecord.entries.push(entry);
    victimRecord.summary.attacks += 1;
    if (data.paladinNear) victimRecord.summary.paladinNearby += 1;
  }

  Object.assign(entry, {
    proximityRoll: data.proximityAutomatic ? null : Number(data.proximityRoll),
    proximityAutomatic: Boolean(data.proximityAutomatic),
    paladinNear: Boolean(data.paladinNear),
    auraBonus: Number(data.auraBonus) || 0,
    auraSource: data.auraSource ?? "",
    abilityRoll: Number(data.abilityRoll) || 0,
    ability: data.ability ?? ""
  });

  records[data.actorId] = victimRecord;
  await game.settings.set(MODULE_ID, "victimRecords", records);
}

async function recordSaveResolution(data) {
  if (!isPrimaryGM()) return;

  const records = getCurseRecords();
  const victimRecord = normalizeVictimRecord(data.actorId, records[data.actorId]);
  let entry = data.recordId
    ? victimRecord.entries.find((candidate) => candidate.id === data.recordId)
    : null;

  if (!entry) {
    data.recordId = createRecordId();
    entry = {
      id: data.recordId,
      scheduledTimestamp: Number(data.scheduledTimestamp) || 0,
      startedAt: Date.now(),
      proximityRoll: data.proximityAutomatic ? null : Number(data.proximityRoll),
      proximityAutomatic: Boolean(data.proximityAutomatic),
      paladinNear: Boolean(data.paladinNear),
      auraBonus: Number(data.auraBonus) || 0,
      auraSource: data.auraSource ?? "",
      abilityRoll: Number(data.abilityRoll) || 0,
      ability: data.ability ?? ""
    };
    victimRecord.entries.push(entry);
    victimRecord.summary.attacks += 1;
  }

  const wasResolved = isFiniteValue(entry.resolvedAt);
  Object.assign(entry, {
    resolvedAt: Date.now(),
    saveTotal: Number(data.saveTotal) || 0,
    naturalRoll: isFiniteValue(data.naturalRoll)
      ? Number(data.naturalRoll)
      : null,
    success: Boolean(data.success),
    usedCriticalAdvantage: Boolean(data.usedCriticalAdvantage),
    criticalLossBonus: Boolean(data.criticalLossBonus),
    nextSaveAdvantageGranted: Boolean(data.nextSaveAdvantageGranted),
    lossRolled: Number(data.lossRolled) || 0,
    lossApplied: Number(data.lossApplied) || 0,
    remainingScore: isFiniteValue(data.remainingScore)
      ? Number(data.remainingScore)
      : null
  });

  if (!wasResolved) {
    victimRecord.summary.saves += 1;
    if (data.success) victimRecord.summary.successes += 1;
    if (Number(data.naturalRoll) === 1) victimRecord.summary.naturalOnes += 1;
    if (Number(data.naturalRoll) === 20) victimRecord.summary.naturalTwenties += 1;
  }

  records[data.actorId] = victimRecord;
  await game.settings.set(MODULE_ID, "victimRecords", records);
}

function formatCalendarTimestamp(timestamp) {
  const simpleCalendar = getSimpleCalendar();
  if (!simpleCalendar?.api?.formatTimestamp || !Number.isFinite(timestamp)) {
    return localize("Calendar.UnknownDate");
  }

  try {
    const formatted = simpleCalendar.api.formatTimestamp(timestamp);
    if (typeof formatted === "string") return formatted;
    if (formatted?.date && formatted?.time) return `${formatted.date} — ${formatted.time}`;
    return formatted?.date ?? localize("Calendar.UnknownDate");
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not format a calendar timestamp.`, error);
    return localize("Calendar.UnknownDate");
  }
}

function getStartOfCurrentDay() {
  const simpleCalendar = getSimpleCalendar();
  if (!simpleCalendar?.api?.currentDateTime || !simpleCalendar?.api?.dateToTimestamp) {
    return null;
  }

  const current = simpleCalendar.api.currentDateTime();
  if (!current) return null;
  return Number(simpleCalendar.api.dateToTimestamp({
    year: current.year,
    month: current.month,
    day: current.day,
    hour: 0,
    minute: 0,
    seconds: 0
  }));
}

function normalizeIntervalDays(value, fallback = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clamp(Math.floor(Number(fallback) || 1), 1, 365);
  return clamp(Math.floor(numeric), 1, 365);
}

function getGlobalIntervalDays() {
  return normalizeIntervalDays(game.settings.get(MODULE_ID, "intervalDays"), 3);
}

function getVictimIntervals() {
  const value = game.settings.get(MODULE_ID, "victimIntervals");
  return value && typeof value === "object" && !Array.isArray(value)
    ? foundry.utils.deepClone(value)
    : {};
}

function getIntervalDaysForActor(actorId, intervals = getVictimIntervals()) {
  const globalInterval = getGlobalIntervalDays();
  if (!Object.hasOwn(intervals, actorId)) return globalInterval;
  return normalizeIntervalDays(intervals[actorId], globalInterval);
}

function getDefaultNextTimestamp(intervalDays = getGlobalIntervalDays()) {
  const simpleCalendar = getSimpleCalendar();
  const start = getStartOfCurrentDay();
  if (!Number.isFinite(start) || !simpleCalendar?.api?.timestampPlusInterval) return 0;

  return Number(simpleCalendar.api.timestampPlusInterval(start, {
    day: normalizeIntervalDays(intervalDays, getGlobalIntervalDays())
  }));
}

function getVictimSchedules() {
  const value = game.settings.get(MODULE_ID, "victimSchedules");
  return value && typeof value === "object" && !Array.isArray(value)
    ? foundry.utils.deepClone(value)
    : {};
}

async function ensureVictimSchedules() {
  if (!isPrimaryGM()) return getVictimSchedules();

  const victimIds = getSelectedVictimIds();
  const current = getVictimSchedules();
  const intervals = getVictimIntervals();
  const legacy = Number(game.settings.get(MODULE_ID, "nextAttackTimestamp"));
  const next = {};

  for (const actorId of victimIds) {
    const existing = Number(current[actorId]);
    const fallback = Number.isFinite(legacy) && legacy > 0
      ? legacy
      : getDefaultNextTimestamp(getIntervalDaysForActor(actorId, intervals));
    next[actorId] = Object.hasOwn(current, actorId) && Number.isFinite(existing)
      ? existing
      : fallback;
  }

  if (JSON.stringify(next) !== JSON.stringify(current)) {
    await game.settings.set(MODULE_ID, "victimSchedules", next);
  }
  return next;
}

async function resetVictimSchedulesFromNow() {
  if (!isPrimaryGM()) return {};
  const intervals = getVictimIntervals();
  const schedules = Object.fromEntries(
    getSelectedVictimIds().map((actorId) => [
      actorId,
      getDefaultNextTimestamp(getIntervalDaysForActor(actorId, intervals))
    ])
  );
  await game.settings.set(MODULE_ID, "victimSchedules", schedules);
  return schedules;
}

async function resetInheritedVictimSchedulesFromNow() {
  if (!isPrimaryGM()) return getVictimSchedules();

  const intervals = getVictimIntervals();
  const schedules = getVictimSchedules();
  let changed = false;
  for (const actorId of getSelectedVictimIds()) {
    if (Object.hasOwn(intervals, actorId)) continue;
    schedules[actorId] = getDefaultNextTimestamp(getGlobalIntervalDays());
    changed = true;
  }

  if (changed) await game.settings.set(MODULE_ID, "victimSchedules", schedules);
  return schedules;
}

function getAttackFlag(message) {
  return message?.getFlag(MODULE_ID, "attack") ?? null;
}

function getActorSpeaker(actor) {
  return ChatMessage.getSpeaker({ actor });
}

function cardStat(label, value, tone = "") {
  return `
    <div class="codd-stat ${tone ? `codd-stat--${tone}` : ""}">
      <span class="codd-stat__label">${escapeHtml(label)}</span>
      <strong class="codd-stat__value">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderAttackCard(data) {
  const actor = game.actors.get(data.actorId);
  const actorName = actor?.name ?? data.actorName ?? localize("Card.UnknownActor");
  const scheduledDate = formatCalendarTimestamp(data.scheduledTimestamp);
  const abilityLabel = data.ability ? getAbilityLabel(data.ability) : "";

  let body = "";
  let action = "";

  if (data.state === "pending") {
    body = `
      <p>${format("Card.PendingText", { actor: actorName })}</p>
      <div class="codd-rule">
        <i class="fa-solid fa-clock"></i>
        <span>${format("Card.ScheduledFor", { date: scheduledDate })}</span>
      </div>
    `;
    action = `
      <button type="button" class="codd-action" data-codd-action="start">
        <i class="fa-solid fa-skull"></i>
        ${escapeHtml(localize("Card.Begin"))}
      </button>
    `;
  }

  if (data.state === "determining") {
    body = `
      <div class="codd-working">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>${escapeHtml(localize("Card.Determining"))}</span>
      </div>
    `;
  }

  if (["ready", "saving", "resolved"].includes(data.state)) {
    const auraTone = data.paladinNear ? "success" : "danger";
    const auraText = data.paladinNear
      ? format("Card.AuraNear", { bonus: data.auraBonus, source: data.auraSource })
      : localize("Card.AuraFar");
    const proximityText = data.proximityAutomatic
      ? localize("Card.PaladinAutomatic")
      : `${data.proximityRoll}/10`;

    body = `
      <div class="codd-stats">
        ${cardStat(localize("Card.Paladin"), proximityText, auraTone)}
        ${cardStat(localize("Card.Aura"), auraText, auraTone)}
        ${cardStat(localize("Card.AttackedAbility"), `${data.abilityRoll}: ${abilityLabel}`)}
        ${cardStat(localize("Card.SaveDC"), data.dc)}
      </div>
    `;

    if (data.usedCriticalAdvantage) {
      body += `
        <div class="codd-rule codd-rule--advantage">
          <i class="fa-solid fa-dice-d20"></i>
          <span>${escapeHtml(localize("Card.AdvantageUsed"))}</span>
        </div>
      `;
    }
  }

  if (data.state === "ready") {
    action = `
      <button type="button" class="codd-action" data-codd-action="save">
        <i class="fa-solid fa-shield-heart"></i>
        ${escapeHtml(format("Card.RollSave", { ability: abilityLabel }))}
      </button>
    `;
  }

  if (data.state === "saving") {
    body += `
      <div class="codd-working">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <span>${escapeHtml(localize("Card.RollingSave"))}</span>
      </div>
    `;
  }

  if (data.state === "resolved") {
    if (data.success) {
      body += `
        <div class="codd-result codd-result--success">
          <i class="fa-solid fa-shield"></i>
          <div>
            <strong>${escapeHtml(localize("Card.Success"))}</strong>
            <span>${format("Card.SuccessDetail", { total: data.saveTotal, dc: data.dc })}</span>
          </div>
        </div>
      `;
    } else {
      const lossDetail = data.lossApplied === data.lossRolled
        ? format("Card.FailureDetail", {
          total: data.saveTotal,
          dc: data.dc,
          loss: data.lossApplied,
          ability: abilityLabel,
          remaining: data.remainingScore
        })
        : format("Card.FailureCappedDetail", {
          total: data.saveTotal,
          dc: data.dc,
          rolled: data.lossRolled,
          loss: data.lossApplied,
          ability: abilityLabel,
          remaining: data.remainingScore
        });

      body += `
        <div class="codd-result codd-result--failure">
          <i class="fa-solid fa-droplet"></i>
          <div>
            <strong>${escapeHtml(localize("Card.Failure"))}</strong>
            <span>${lossDetail}</span>
          </div>
        </div>
      `;

      if (data.criticalLossBonus) {
        body += `
          <div class="codd-rule codd-rule--critical">
            <i class="fa-solid fa-dice-one"></i>
            <span>${escapeHtml(localize("Card.NaturalOne"))}</span>
          </div>
        `;
      }

      if (data.deathThresholdReached) {
        body += `
          <div class="codd-death">
            <i class="fa-solid fa-skull-crossbones"></i>
            <span>${format("Card.DeathThreshold", { actor: actorName, ability: abilityLabel })}</span>
          </div>
        `;
      }
    }

    if (data.nextSaveAdvantageGranted) {
      body += `
        <div class="codd-rule codd-rule--advantage">
          <i class="fa-solid fa-dice-d20"></i>
          <span>${escapeHtml(localize("Card.NaturalTwenty"))}</span>
        </div>
      `;
    }
  }

  return `
    <article class="codd-card" data-codd-actor-id="${escapeHtml(data.actorId)}">
      <header class="codd-card__header">
        <img src="${ICON_PATH}" alt="">
        <div>
          <h3>${escapeHtml(localize("Card.Title"))}</h3>
          <span>${escapeHtml(actorName)}</span>
        </div>
      </header>
      <section class="codd-card__body">${body}</section>
      ${action ? `<footer class="codd-card__footer">${action}</footer>` : ""}
    </article>
  `;
}

async function updateAttackMessage(message, data) {
  await message.update({
    content: renderAttackCard(data),
    [`flags.${MODULE_ID}.attack`]: data
  });
}

async function createAttackCard(actor, scheduledTimestamp, { manual = false } = {}) {
  const data = {
    version: 3,
    actorId: actor.id,
    actorName: actor.name,
    scheduledTimestamp,
    manual,
    state: "pending",
    dc: Math.max(1, Number(game.settings.get(MODULE_ID, "saveDC")) || 18),
    paladinChance: clamp(
      Number(game.settings.get(MODULE_ID, "paladinChance")) || 0,
      0,
      10
    ),
    lossFormula: String(game.settings.get(MODULE_ID, "abilityLossFormula") || "1d4")
  };

  const message = await ChatMessage.create({
    user: game.user.id,
    speaker: getActorSpeaker(actor),
    content: renderAttackCard(data),
    flags: {
      [MODULE_ID]: {
        attack: data
      }
    }
  });
  data.messageId = message.id;
  await message.update({
    [`flags.${MODULE_ID}.attack`]: data
  });
  return message;
}

async function createAttackCardsForVictims(scheduledTimestamp, options = {}) {
  const victims = getSelectedVictims();
  if (!victims.length) {
    ui.notifications.warn(localize("Notifications.NoVictims"));
    return [];
  }

  const created = [];
  for (const actor of victims) {
    created.push(await createAttackCard(actor, scheduledTimestamp, options));
  }
  return created;
}

async function processCalendarDateChange() {
  if (calendarProcessing || !isPrimaryGM()) return;

  const simpleCalendar = getSimpleCalendar();
  if (!simpleCalendar?.api?.timestamp || !simpleCalendar?.api?.timestampPlusInterval) return;

  calendarProcessing = true;
  try {
    const schedules = await ensureVictimSchedules();
    const now = Number(simpleCalendar.api.timestamp());
    const intervals = getVictimIntervals();
    if (!Number.isFinite(now)) return;

    let changed = false;
    let capped = false;
    for (const actor of getSelectedVictims()) {
      let next = Number(schedules[actor.id]);
      if (!Number.isFinite(next)) continue;
      const intervalDays = getIntervalDaysForActor(actor.id, intervals);

      let cycles = 0;
      while (now >= next && cycles < MAX_MISSED_CYCLES) {
        await createAttackCard(actor, next);
        next = Number(simpleCalendar.api.timestampPlusInterval(next, { day: intervalDays }));
        cycles += 1;
      }

      if (cycles === MAX_MISSED_CYCLES && now >= next) {
        while (now >= next) {
          next = Number(simpleCalendar.api.timestampPlusInterval(next, { day: intervalDays }));
        }
        capped = true;
      }

      if (cycles > 0) {
        schedules[actor.id] = next;
        changed = true;
      }
    }

    if (changed) await game.settings.set(MODULE_ID, "victimSchedules", schedules);
    if (capped) {
      console.warn(`${MODULE_ID} | More than ${MAX_MISSED_CYCLES} curse cycles were skipped for at least one victim.`);
      ui.notifications.warn(localize("Notifications.MissedCyclesCapped"));
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Failed while processing a calendar change.`, error);
    ui.notifications.error(localize("Notifications.CalendarError"));
  } finally {
    calendarProcessing = false;
  }
}

async function rollToChat(formula, flavor, actor) {
  const roll = await new Roll(formula).evaluate();
  await roll.toMessage({
    speaker: getActorSpeaker(actor),
    flavor
  }, {
    rollMode: getRollModeForActor(actor)
  });
  return roll;
}

async function handleStartRequest(message, data) {
  const actor = game.actors.get(data.actorId);
  if (!actor) throw new Error(`Actor ${data.actorId} no longer exists.`);

  data.messageId = message.id;
  data.state = "determining";
  await updateAttackMessage(message, data);

  try {
    const selfAura = getActorAuraDetails(actor);
    let proximityRoll = null;
    let proximityAutomatic = false;
    let paladinNear = false;
    let aura = { bonus: 0, source: "", actorId: null };

    if (selfAura) {
      proximityAutomatic = true;
      paladinNear = true;
      aura = selfAura;
    } else {
      proximityRoll = await rollToChat(
        "1d10",
        format("Rolls.PaladinProximity", { actor: actor.name, target: data.paladinChance }),
        actor
      );
      paladinNear = proximityRoll.total <= data.paladinChance;
      aura = paladinNear ? getAuraDetails() : aura;
    }

    const abilityRoll = await rollToChat(
      "1d6",
      format("Rolls.AbilityTarget", { actor: actor.name }),
      actor
    );
    const ability = ABILITY_BY_D6[clamp(Number(abilityRoll.total), 1, 6)];

    Object.assign(data, {
      state: "ready",
      proximityRoll: proximityRoll?.total ?? null,
      proximityAutomatic,
      paladinNear,
      auraBonus: aura.bonus,
      auraSource: aura.source,
      auraActorId: aura.actorId,
      abilityRoll: abilityRoll.total,
      ability
    });
    await recordAttackDetermination(data);
    await updateAttackMessage(message, data);
  } catch (error) {
    data.state = "pending";
    await updateAttackMessage(message, data);
    throw error;
  }
}

function extractRoll(value) {
  if (!value) return null;
  if (value instanceof Roll) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const roll = extractRoll(entry);
      if (roll) return roll;
    }
    return null;
  }
  if (value.roll instanceof Roll) return value.roll;
  if (Array.isArray(value.rolls)) return extractRoll(value.rolls);
  if (Number.isFinite(value.total)) return value;
  return null;
}

function getNaturalD20(roll) {
  const dice = Array.isArray(roll?.dice)
    ? roll.dice
    : (Array.isArray(roll?.terms) ? roll.terms : []);
  const d20 = dice.find((term) => Number(term?.faces) === 20);
  if (!d20) return null;

  const results = Array.isArray(d20.results) ? d20.results : [];
  const kept = results.find((result) =>
    result?.active !== false
    && result?.discarded !== true
    && Number.isFinite(Number(result?.result))
  );
  return kept ? Number(kept.result) : null;
}

function getNextSaveAdvantageEffect(actor) {
  return actor.effects.find(
    (effect) => !effect.disabled && effect.getFlag(MODULE_ID, "nextSaveAdvantage")
  ) ?? null;
}

async function grantNextSaveAdvantage(actor) {
  if (getNextSaveAdvantageEffect(actor)) return;
  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: localize("Effect.NextSaveAdvantage"),
    img: ICON_PATH,
    disabled: false,
    changes: [],
    flags: {
      [MODULE_ID]: {
        nextSaveAdvantage: true
      }
    }
  }]);
}

async function rollSavingThrow(actor, ability, dc, auraBonus, advantage = false) {
  let temporaryEffect = null;
  let capturedRoll = null;

  const hookId = Hooks.on("dnd5e.rollSavingThrow", (rolls, hookData) => {
    const subjectId = hookData?.subject?.id;
    if (subjectId !== actor.id || hookData?.ability !== ability) return;
    capturedRoll = extractRoll(rolls);
  });

  try {
    if (auraBonus > 0) {
      const [effect] = await actor.createEmbeddedDocuments("ActiveEffect", [{
        name: localize("Effect.TemporaryAura"),
        img: ICON_PATH,
        disabled: false,
        changes: [{
          key: `system.abilities.${ability}.bonuses.save`,
          mode: CONST.ACTIVE_EFFECT_MODES.ADD,
          value: String(auraBonus),
          priority: 20
        }],
        flags: {
          [MODULE_ID]: {
            temporaryAura: true
          }
        }
      }]);
      temporaryEffect = effect;
    }

    const result = await actor.rollSavingThrow(
      { ability, target: dc, advantage },
      {},
      {
        rollMode: getRollModeForActor(actor),
        data: { speaker: getActorSpeaker(actor) }
      }
    );
    return extractRoll(result) ?? capturedRoll;
  } finally {
    Hooks.off("dnd5e.rollSavingThrow", hookId);
    if (temporaryEffect) {
      await temporaryEffect.delete().catch((error) => {
        console.error(`${MODULE_ID} | Could not remove a temporary aura effect.`, error);
      });
    }
  }
}

function getManagedDrainEffect(actor) {
  return actor.effects.find((effect) => effect.getFlag(MODULE_ID, "managedDrain")) ?? null;
}

async function applyAbilityDrain(actor, ability, rolledLoss) {
  const currentScore = Math.max(0, Number(actor.system?.abilities?.[ability]?.value ?? 0));
  const appliedLoss = Math.min(Math.max(0, Math.floor(rolledLoss)), currentScore);
  const remainingScore = Math.max(0, currentScore - appliedLoss);

  if (appliedLoss <= 0) {
    return {
      appliedLoss,
      remainingScore,
      deathThresholdReached: currentScore <= 0
    };
  }

  const existing = getManagedDrainEffect(actor);
  const losses = foundry.utils.deepClone(existing?.getFlag(MODULE_ID, "losses") ?? {});
  losses[ability] = Math.max(0, Number(losses[ability]) || 0) + appliedLoss;

  const changes = Object.entries(losses)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([abilityId, amount]) => ({
      key: `system.abilities.${abilityId}.value`,
      mode: CONST.ACTIVE_EFFECT_MODES.ADD,
      value: String(-Math.abs(Number(amount))),
      priority: 20
    }));

  const effectData = {
    name: localize("Effect.DrainName"),
    img: ICON_PATH,
    disabled: false,
    changes,
    [`flags.${MODULE_ID}.managedDrain`]: true,
    [`flags.${MODULE_ID}.losses`]: losses
  };

  if (existing) {
    await existing.update(effectData);
  } else {
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: effectData.name,
      img: effectData.img,
      disabled: false,
      changes,
      flags: {
        [MODULE_ID]: {
          managedDrain: true,
          losses
        }
      }
    }]);
  }

  return {
    appliedLoss,
    remainingScore,
    deathThresholdReached: remainingScore <= 0
  };
}

async function evaluateLossFormula(formula, actor, criticalBonus = false) {
  const adjustedFormula = criticalBonus ? `(${formula}) + 1` : formula;
  try {
    const roll = await rollToChat(
      adjustedFormula,
      format("Rolls.AbilityLoss", { actor: actor.name }),
      actor
    );
    return Math.max(0, Math.floor(Number(roll.total) || 0));
  } catch (error) {
    console.error(`${MODULE_ID} | Invalid ability loss formula "${formula}". Falling back to 1d4.`, error);
    ui.notifications.warn(format("Notifications.InvalidLossFormula", { formula }));
    const fallbackFormula = criticalBonus ? "(1d4) + 1" : "1d4";
    const fallback = await rollToChat(
      fallbackFormula,
      format("Rolls.AbilityLoss", { actor: actor.name }),
      actor
    );
    return Math.max(0, Math.floor(Number(fallback.total) || 0));
  }
}

async function handleSaveRequest(message, data) {
  const actor = game.actors.get(data.actorId);
  if (!actor) throw new Error(`Actor ${data.actorId} no longer exists.`);

  data.state = "saving";
  await updateAttackMessage(message, data);

  const advantageEffect = getNextSaveAdvantageEffect(actor);
  try {
    const roll = await rollSavingThrow(
      actor,
      data.ability,
      data.dc,
      data.paladinNear ? data.auraBonus : 0,
      Boolean(advantageEffect)
    );

    if (!roll || !Number.isFinite(Number(roll.total))) {
      data.state = "ready";
      await updateAttackMessage(message, data);
      ui.notifications.warn(localize("Notifications.SaveCancelled"));
      return;
    }

    if (advantageEffect) await advantageEffect.delete();

    const saveTotal = Number(roll.total);
    const naturalRoll = getNaturalD20(roll);
    const success = saveTotal >= data.dc;
    const criticalLossBonus = !success && naturalRoll === 1;
    const nextSaveAdvantageGranted = naturalRoll === 20;

    if (nextSaveAdvantageGranted) await grantNextSaveAdvantage(actor);

    Object.assign(data, {
      state: "resolved",
      success,
      saveTotal,
      naturalRoll,
      usedCriticalAdvantage: Boolean(advantageEffect),
      criticalLossBonus,
      nextSaveAdvantageGranted
    });

    if (!success) {
      const lossRolled = await evaluateLossFormula(
        data.lossFormula,
        actor,
        criticalLossBonus
      );
      const drain = await applyAbilityDrain(actor, data.ability, lossRolled);
      Object.assign(data, {
        lossRolled,
        lossApplied: drain.appliedLoss,
        remainingScore: drain.remainingScore,
        deathThresholdReached: drain.deathThresholdReached
      });
    }

    await recordSaveResolution(data);
    await updateAttackMessage(message, data);
  } catch (error) {
    data.state = "ready";
    await updateAttackMessage(message, data);
    throw error;
  }
}

async function handleActionRequest(payload) {
  if (!isPrimaryGM()) return;

  const requester = game.users.get(payload.requesterId);
  if (!requester) return;

  if (payload.action === "manualAttackAll") {
    if (!requester.isGM) return;
    const simpleCalendar = getSimpleCalendar();
    const timestamp = Number(simpleCalendar?.api?.timestamp?.() ?? 0);
    await createAttackCardsForVictims(timestamp, { manual: true });
    return;
  }

  if (payload.action === "resetSchedule") {
    if (!requester.isGM) return;
    await resetVictimSchedulesFromNow();
    ui.notifications.info(localize("Notifications.ScheduleReset"));
    return;
  }

  const message = game.messages.get(payload.messageId);
  const data = getAttackFlag(message);
  if (!message || !data) return;

  const actor = game.actors.get(data.actorId);
  if (!canControlActor(actor, requester)) return;

  if (payload.action === "start" && data.state === "pending") {
    await handleStartRequest(message, data);
  } else if (payload.action === "save" && data.state === "ready") {
    await handleSaveRequest(message, data);
  }
}

function requestAction(action, messageId = null) {
  const payload = {
    action,
    messageId,
    requesterId: game.user.id
  };

  if (isPrimaryGM()) {
    handleActionRequest(payload).catch((error) => {
      console.error(`${MODULE_ID} | Action "${action}" failed.`, error);
      ui.notifications.error(localize("Notifications.ActionError"));
    });
  } else {
    game.socket.emit(SOCKET_NAME, payload);
  }
}

async function removeManagedCurseEffects(actorIds = getSelectedVictimIds()) {
  if (!game.user.isGM) return;

  const victims = actorIds
    .map((id) => game.actors.get(id))
    .filter(Boolean);
  let removed = 0;
  for (const actor of victims) {
    const effectIds = actor.effects
      .filter((effect) =>
        effect.getFlag(MODULE_ID, "managedDrain")
        || effect.getFlag(MODULE_ID, "nextSaveAdvantage")
      )
      .map((effect) => effect.id);
    if (!effectIds.length) continue;
    await actor.deleteEmbeddedDocuments("ActiveEffect", effectIds);
    removed += effectIds.length;
  }

  ui.notifications.info(format("Notifications.EffectsRemoved", { count: removed }));
}

class CurseConfiguration extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-configuration`,
      title: localize("Config.Title"),
      template: `modules/${MODULE_ID}/templates/configuration.hbs`,
      width: 780,
      height: 800,
      resizable: true,
      closeOnSubmit: true
    });
  }

  getData() {
    const selectedIds = new Set(getSelectedVictimIds());
    const selectedPaladinId = game.settings.get(MODULE_ID, "paladinActorId");
    const victimIntervals = getVictimIntervals();
    const victimRollModes = getVictimRollModes();
    const defaultRollMode = String(
      game.settings.get(MODULE_ID, "rollMode") || "publicroll"
    );
    const globalIntervalDays = getGlobalIntervalDays();
    const availableActors = getConfigurableActors()
      .map((actor) => {
        const intervalInherited = !Object.hasOwn(victimIntervals, actor.id);
        const intervalDays = intervalInherited
          ? globalIntervalDays
          : normalizeIntervalDays(victimIntervals[actor.id], globalIntervalDays);
        const actorRollMode = actor.type === "npc"
          ? "blindroll"
          : String(victimRollModes[actor.id] ?? defaultRollMode);
        const rollModeOptions = Object.keys(ROLL_MODE_LABELS).map((value) => ({
          value,
          label: getRollModeLabel(value),
          selected: value === actorRollMode
        }));
        return {
          id: actor.id,
          name: actor.name ?? localize("Card.UnknownActor"),
          img: actor.img ?? "icons/svg/mystery-man.svg",
          selected: selectedIds.has(actor.id),
          paladin: isPaladinActor(actor),
          paladinLevel: getPaladinLevel(actor),
          effect: getManagedDrainEffect(actor)?.name ?? "",
          npc: actor.type === "npc",
          rollMode: actorRollMode,
          rollModeOptions,
          intervalDays,
          intervalInherited
        };
      })
      .sort((a, b) =>
        Number(b.selected) - Number(a.selected)
        || String(a.name).localeCompare(String(b.name))
      );

    const auraSources = [
      {
        id: "",
        name: localize("Config.PaladinAutomatic"),
        chosen: !selectedPaladinId,
        paladin: false
      },
      ...availableActors.map((actor) => ({
        ...actor,
        chosen: actor.id === selectedPaladinId
      }))
    ].sort((a, b) =>
      Number(b.chosen) - Number(a.chosen)
      || String(a.name).localeCompare(String(b.name))
    );

    return {
      availableActors,
      hasAvailableActors: availableActors.length > 0,
      auraSources,
      settings: {
        saveDC: Number(game.settings.get(MODULE_ID, "saveDC")) || 18,
        paladinChance: Number(game.settings.get(MODULE_ID, "paladinChance")) || 0,
        fallbackAuraBonus: Number(
          game.settings.get(MODULE_ID, "fallbackAuraBonus")
        ) || 0,
        intervalDays: globalIntervalDays,
        abilityLossFormula: String(
          game.settings.get(MODULE_ID, "abilityLossFormula") || "1d4"
        ),
        spellHealingPenalty: Number(
          game.settings.get(MODULE_ID, "spellHealingPenalty")
        ) || 0,
        spellHealingScope: String(
          game.settings.get(MODULE_ID, "spellHealingScope") || "victims"
        ),
        spellHealingScopeOptions: [
          {
            value: "victims",
            label: localize("Settings.SpellHealingScope.Victims")
          },
          {
            value: "everyone",
            label: localize("Settings.SpellHealingScope.Everyone")
          }
        ].map((option) => ({
          ...option,
          selected: option.value === String(
            game.settings.get(MODULE_ID, "spellHealingScope") || "victims"
          )
        }))
      }
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const syncVictimControls = (checkbox) => {
      const row = checkbox.closest("[data-codd-actor]");
      for (const input of row?.querySelectorAll("[data-codd-victim-input]") ?? []) {
        input.disabled = !checkbox.checked;
      }
      const rollMode = row?.querySelector("[data-codd-roll-mode]");
      if (rollMode) {
        rollMode.disabled = !checkbox.checked || rollMode.dataset.coddNpc === "true";
      }
    };
    html.find('input[name="victims"]').each((_, checkbox) => {
      syncVictimControls(checkbox);
      checkbox.addEventListener("change", () => syncVictimControls(checkbox));
    });

    html.find("[data-codd-search]").on("input", (event) => {
      const query = String(event.currentTarget.value ?? "").trim().toLocaleLowerCase();
      html.find("[data-codd-actor]").each((_, row) => {
        const actorName = String(row.dataset.coddActorName ?? "").toLocaleLowerCase();
        row.hidden = Boolean(query) && !actorName.includes(query);
      });
    });

    html.find("[data-codd-interval]").on("input", (event) => {
      event.currentTarget.dataset.coddInherited = "false";
    });

    html.find('[data-codd-setting="intervalDays"]').on("input", (event) => {
      const globalInterval = normalizeIntervalDays(
        event.currentTarget.value,
        getGlobalIntervalDays()
      );
      html.find('[data-codd-interval][data-codd-inherited="true"]').each(
        (_, input) => {
          input.value = String(globalInterval);
        }
      );
    });

    html.find("[data-codd-use-global]").on("click", (event) => {
      const row = event.currentTarget.closest("[data-codd-actor]");
      const input = row?.querySelector("[data-codd-interval]");
      const globalInput = html[0]?.querySelector('[data-codd-setting="intervalDays"]');
      if (!input) return;
      input.value = String(
        normalizeIntervalDays(globalInput?.value, getGlobalIntervalDays())
      );
      input.dataset.coddInherited = "true";
    });

    html.find('[data-action="test-now"]').on("click", () => {
      requestAction("manualAttackAll");
      this.close();
    });
    html.find('[data-action="reset-schedule"]').on("click", () => {
      requestAction("resetSchedule");
      this.close();
    });
    html.find('[data-action="remove-effects"]').on("click", async () => {
      const actorIds = html.find('input[name="victims"]:checked')
        .map((_, input) => input.value)
        .get();
      const confirmed = await Dialog.confirm({
        title: localize("Config.RemoveEffectsTitle"),
        content: `<p>${escapeHtml(localize("Config.RemoveEffectsConfirm"))}</p>`
      });
      if (!confirmed) return;
      await removeManagedCurseEffects(actorIds);
      this.render();
    });
    html.find('[data-action="open-records"]').on("click", () => {
      openRecordsApplication();
    });
  }

  async _updateObject(event, formData) {
    const form = event.currentTarget;
    const victimIds = Array.from(
      form.querySelectorAll('input[name="victims"]:checked')
    ).map((input) => input.value);
    const paladinActorId = String(formData.paladinActorId ?? "");
    const previousVictimIds = new Set(getSelectedVictimIds());
    const previousGlobalInterval = getGlobalIntervalDays();
    const currentSchedules = getVictimSchedules();
    const currentIntervals = getVictimIntervals();
    const victimSchedules = {};
    const victimIntervals = foundry.utils.deepClone(currentIntervals);
    const victimRollModes = getVictimRollModes();

    const settingInputs = {
      saveDC: "number",
      paladinChance: "number",
      fallbackAuraBonus: "number",
      intervalDays: "number",
      abilityLossFormula: "string",
      spellHealingPenalty: "number",
      spellHealingScope: "string"
    };
    suppressGlobalIntervalReset = true;
    try {
      for (const [setting, type] of Object.entries(settingInputs)) {
        const input = form.querySelector(`[data-codd-setting="${setting}"]`);
        if (!input) continue;
        const value = setting === "intervalDays"
          ? normalizeIntervalDays(input.value, previousGlobalInterval)
          : (type === "number" ? Number(input.value) : String(input.value));
        await game.settings.set(MODULE_ID, setting, value);
      }
    } finally {
      suppressGlobalIntervalReset = false;
    }
    const nextGlobalInterval = getGlobalIntervalDays();

    for (const actorId of victimIds) {
      const row = Array.from(form.querySelectorAll("[data-codd-actor]"))
        .find((element) => element.dataset.coddActor === actorId);
      const actor = game.actors.get(actorId);
      const selectedRollMode = actor?.type === "npc"
        ? "blindroll"
        : String(row?.querySelector("[data-codd-roll-mode]")?.value ?? "publicroll");
      victimRollModes[actorId] = Object.hasOwn(ROLL_MODE_LABELS, selectedRollMode)
        ? selectedRollMode
        : "publicroll";
      const intervalInput = row?.querySelector("[data-codd-interval]");
      const intervalInherited = intervalInput?.dataset.coddInherited === "true";
      const nextInterval = intervalInherited
        ? nextGlobalInterval
        : normalizeIntervalDays(intervalInput?.value, nextGlobalInterval);
      if (intervalInherited) delete victimIntervals[actorId];
      else victimIntervals[actorId] = nextInterval;

      const previousInterval = Object.hasOwn(currentIntervals, actorId)
        ? normalizeIntervalDays(currentIntervals[actorId], previousGlobalInterval)
        : previousGlobalInterval;
      const previousTimestamp = Number(currentSchedules[actorId]);
      const shouldResetSchedule = !previousVictimIds.has(actorId)
        || !Number.isFinite(previousTimestamp)
        || previousInterval !== nextInterval;
      victimSchedules[actorId] = shouldResetSchedule
        ? getDefaultNextTimestamp(nextInterval)
        : previousTimestamp;
    }

    await game.settings.set(MODULE_ID, "victimActorIds", victimIds);
    await game.settings.set(MODULE_ID, "paladinActorId", paladinActorId);
    await game.settings.set(MODULE_ID, "victimSchedules", victimSchedules);
    await game.settings.set(MODULE_ID, "victimIntervals", victimIntervals);
    await game.settings.set(MODULE_ID, "victimRollModes", victimRollModes);
    await ensureVictimSchedules();
    await ensureRulesJournal();
    ui.notifications.info(localize("Notifications.ConfigurationSaved"));
  }
}

function getShareFieldsForUser(actorId, userId) {
  const shares = getRecordShares();
  const fields = shares?.[actorId]?.[userId];
  return Array.isArray(fields)
    ? fields.filter((field) => RECORD_SHARE_FIELDS.includes(field))
    : [];
}

function parseNullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getRecordsActorIds() {
  return [...new Set([
    ...getSelectedVictimIds(),
    ...Object.keys(getCurseRecords())
  ])].filter((actorId) => game.actors.get(actorId));
}

class CurseRecords extends FormApplication {
  constructor(object = {}, options = {}) {
    super(object, options);
    this.selectedActorId = options.actorId ?? "";
    this.expandedRecordIds = new Set();
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-records`,
      title: localize("Records.Title"),
      template: `modules/${MODULE_ID}/templates/records.hbs`,
      width: 900,
      height: 650,
      resizable: true,
      closeOnSubmit: false
    });
  }

  getData() {
    const records = getCurseRecords();
    const recordShares = getRecordShares();
    const isGM = Boolean(game.user?.isGM);
    const actorIds = getRecordsActorIds().filter((actorId) => {
      if (isGM) return true;
      return getShareFieldsForUser(actorId, game.user.id).length > 0;
    });
    const actors = actorIds
      .map((actorId) => game.actors.get(actorId))
      .filter(Boolean)
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

    if (!actors.some((actor) => actor.id === this.selectedActorId)) {
      this.selectedActorId = actors[0]?.id ?? "";
    }

    const selectedActor = game.actors.get(this.selectedActorId) ?? null;
    const victimRecord = selectedActor
      ? normalizeVictimRecord(selectedActor.id, records[selectedActor.id])
      : null;
    const sharedFields = new Set(
      isGM
        ? RECORD_SHARE_FIELDS
        : getShareFieldsForUser(this.selectedActorId, game.user.id)
    );

    const summary = victimRecord?.summary ?? emptyRecordSummary();
    const summaryFields = [
      { key: "attacks", label: localize("Records.Attacks"), value: summary.attacks, visible: sharedFields.has("totals") },
      { key: "saves", label: localize("Records.Saves"), value: summary.saves, visible: sharedFields.has("totals") },
      { key: "successes", label: localize("Records.Successes"), value: summary.successes, visible: sharedFields.has("totals") },
      { key: "naturalOnes", label: localize("Records.NaturalOnes"), value: summary.naturalOnes, visible: sharedFields.has("criticals") },
      { key: "naturalTwenties", label: localize("Records.NaturalTwenties"), value: summary.naturalTwenties, visible: sharedFields.has("criticals") },
      { key: "paladinNearby", label: localize("Records.PaladinNearby"), value: summary.paladinNearby, visible: sharedFields.has("paladin") }
    ].filter((field) => isGM || field.visible);

    const sortedEntries = (victimRecord?.entries ?? [])
      .slice()
      .sort((a, b) => Number(b.startedAt ?? 0) - Number(a.startedAt ?? 0));
    const entries = sortedEntries
      .map((entry, index) => {
        const expansionKey = `${this.selectedActorId}:${entry.id}`;
        return {
          ...entry,
          attackLabel: format("Records.AttackNumber", {
            number: sortedEntries.length - index
          }),
          expanded: this.expandedRecordIds.has(expansionKey),
          dateLabel: formatCalendarTimestamp(Number(entry.scheduledTimestamp)),
          proximityDisplay: entry.proximityAutomatic
            ? localize("Records.AutomaticAura")
            : (isFiniteValue(entry.proximityRoll) ? Number(entry.proximityRoll) : "—"),
          abilityLabel: entry.ability ? getAbilityLabel(entry.ability) : "—",
          outcomeLabel: isFiniteValue(entry.resolvedAt)
            ? (entry.success ? localize("Card.Success") : localize("Card.Failure"))
            : localize("Records.NotResolved"),
          saveDisplay: isFiniteValue(entry.saveTotal) ? Number(entry.saveTotal) : "—",
          naturalDisplay: isFiniteValue(entry.naturalRoll) ? Number(entry.naturalRoll) : "—",
          lossDisplay: isFiniteValue(entry.lossApplied) ? Number(entry.lossApplied) : "—",
          abilityOptions: Object.keys(ABILITY_BY_D6).map(
            (roll) => ABILITY_BY_D6[roll]
          ).map((abilityId) => ({
            value: abilityId,
            label: getAbilityLabel(abilityId),
            selected: abilityId === entry.ability
          }))
        };
      });

    const users = isGM
      ? game.users
        .filter((user) => !user.isGM)
        .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
        .map((user) => {
          const granted = new Set(recordShares?.[this.selectedActorId]?.[user.id] ?? []);
          return {
            id: user.id,
            name: user.name,
            active: user.active,
            fields: RECORD_SHARE_FIELDS.map((field) => ({
              key: field,
              label: localize(`Records.Share.${field}`),
              checked: granted.has(field)
            }))
          };
        })
      : [];

    return {
      isGM,
      actors: actors.map((actor) => ({
        id: actor.id,
        name: actor.name,
        selected: actor.id === this.selectedActorId
      })),
      hasActors: actors.length > 0,
      selectedActor: selectedActor
        ? {
          id: selectedActor.id,
          name: selectedActor.name,
          img: selectedActor.img ?? "icons/svg/mystery-man.svg"
        }
        : null,
      summaryFields,
      entries,
      hasEntries: entries.length > 0,
      users,
      showTotals: sharedFields.has("totals"),
      showCriticals: sharedFields.has("criticals"),
      showPaladin: sharedFields.has("paladin"),
      showRolls: sharedFields.has("rolls"),
      showAbilities: sharedFields.has("abilities"),
      showLosses: sharedFields.has("losses"),
      showHistory: isGM || ["paladin", "rolls", "abilities", "losses"]
        .some((field) => sharedFields.has(field))
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-codd-record-actor]").on("change", (event) => {
      this.selectedActorId = String(event.currentTarget.value ?? "");
      this.render();
    });

    html.find('[data-action="toggle-record"]').on("click", (event) => {
      const button = event.currentTarget;
      const row = button.closest("[data-codd-record-row]");
      const body = row?.querySelector("[data-codd-record-body]");
      if (!row || !body) return;

      const expansionKey = `${this.selectedActorId}:${row.dataset.coddRecordRow}`;
      const expanded = button.getAttribute("aria-expanded") === "true";
      const nextExpanded = !expanded;
      button.setAttribute("aria-expanded", String(nextExpanded));
      button.setAttribute(
        "title",
        localize(nextExpanded
          ? "Records.CollapseRecord"
          : "Records.ExpandRecord")
      );
      body.hidden = !nextExpanded;
      row.classList.toggle("codd-history--expanded", nextExpanded);
      button.querySelector("i")?.classList.toggle("fa-chevron-right", !nextExpanded);
      button.querySelector("i")?.classList.toggle("fa-chevron-down", nextExpanded);

      if (nextExpanded) this.expandedRecordIds.add(expansionKey);
      else this.expandedRecordIds.delete(expansionKey);
    });

    html.find('[data-action="delete-record"]').on("click", async (event) => {
      if (!game.user.isGM) return;
      const confirmed = await Dialog.confirm({
        title: localize("Records.DeleteTitle"),
        content: `<p>${escapeHtml(localize("Records.DeleteConfirm"))}</p>`
      });
      if (!confirmed) return;
      const row = event.currentTarget.closest("[data-codd-record-row]");
      if (row) {
        this.expandedRecordIds.delete(
          `${this.selectedActorId}:${row.dataset.coddRecordRow}`
        );
        row.remove();
      }
    });

    html.find('[data-action="recalculate-summary"]').on("click", () => {
      if (!game.user.isGM) return;
      const rows = Array.from(
        html[0]?.querySelectorAll("[data-codd-record-row]") ?? []
      );
      const values = {
        attacks: rows.length,
        saves: rows.filter((row) =>
          row.querySelector('[data-field="saveTotal"]')?.value !== ""
        ).length,
        successes: rows.filter((row) =>
          row.querySelector('[data-field="success"]')?.checked
        ).length,
        naturalOnes: rows.filter((row) =>
          Number(row.querySelector('[data-field="naturalRoll"]')?.value) === 1
        ).length,
        naturalTwenties: rows.filter((row) =>
          Number(row.querySelector('[data-field="naturalRoll"]')?.value) === 20
        ).length,
        paladinNearby: rows.filter((row) =>
          row.querySelector('[data-field="paladinNear"]')?.checked
        ).length
      };
      for (const [key, value] of Object.entries(values)) {
        const input = html[0]?.querySelector(`[data-codd-summary="${key}"]`);
        if (input) input.value = String(value);
      }
    });
  }

  async _updateObject(event) {
    if (!game.user.isGM || !this.selectedActorId) return;

    const form = event.currentTarget;
    const records = getCurseRecords();
    const existing = normalizeVictimRecord(
      this.selectedActorId,
      records[this.selectedActorId]
    );
    const summary = {};
    for (const key of Object.keys(emptyRecordSummary())) {
      const input = form.querySelector(`[data-codd-summary="${key}"]`);
      summary[key] = Math.max(0, Math.floor(Number(input?.value) || 0));
    }

    const oldEntries = new Map(
      existing.entries.map((entry) => [entry.id, entry])
    );
    const entries = Array.from(
      form.querySelectorAll("[data-codd-record-row]")
    ).map((row) => {
      const id = String(row.dataset.coddRecordRow);
      const previous = oldEntries.get(id) ?? { id };
      const field = (name) => row.querySelector(`[data-field="${name}"]`);
      return {
        ...previous,
        id,
        scheduledTimestamp: Number(field("scheduledTimestamp")?.value) || 0,
        startedAt: Number(field("startedAt")?.value) || Date.now(),
        resolvedAt: parseNullableNumber(field("resolvedAt")?.value),
        proximityRoll: parseNullableNumber(field("proximityRoll")?.value),
        proximityAutomatic: Boolean(field("proximityAutomatic")?.checked),
        paladinNear: Boolean(field("paladinNear")?.checked),
        auraBonus: Number(field("auraBonus")?.value) || 0,
        auraSource: String(field("auraSource")?.value ?? ""),
        abilityRoll: Number(field("abilityRoll")?.value) || 0,
        ability: String(field("ability")?.value ?? ""),
        saveTotal: parseNullableNumber(field("saveTotal")?.value),
        naturalRoll: parseNullableNumber(field("naturalRoll")?.value),
        success: Boolean(field("success")?.checked),
        lossRolled: Number(field("lossRolled")?.value) || 0,
        lossApplied: Number(field("lossApplied")?.value) || 0,
        remainingScore: parseNullableNumber(field("remainingScore")?.value)
      };
    });

    records[this.selectedActorId] = {
      version: 1,
      actorId: this.selectedActorId,
      summary: normalizeRecordSummary(summary),
      entries
    };
    await game.settings.set(MODULE_ID, "victimRecords", records);

    const shares = getRecordShares();
    shares[this.selectedActorId] = {};
    for (const user of game.users.filter((candidate) => !candidate.isGM)) {
      const granted = RECORD_SHARE_FIELDS.filter((field) =>
        form.querySelector(
          `[data-codd-share-user="${user.id}"][data-codd-share-field="${field}"]`
        )?.checked
      );
      if (granted.length) shares[this.selectedActorId][user.id] = granted;
    }
    await game.settings.set(MODULE_ID, "victimRecordShares", shares);

    ui.notifications.info(localize("Notifications.RecordsSaved"));
    this.render();
  }
}

function openConfigurationApplication() {
  if (!game.user?.isGM) return;
  if (!configurationApplication) configurationApplication = new CurseConfiguration();
  configurationApplication.render(true);
}

function openRecordsApplication(actorId = "") {
  if (!recordsApplication) {
    recordsApplication = new CurseRecords({}, { actorId });
  } else if (actorId) {
    recordsApplication.selectedActorId = actorId;
  }
  recordsApplication.render(true);
}

function getQuickAccessState() {
  const saved = game.settings.get(MODULE_ID, "quickAccessState");
  return {
    left: Number.isFinite(Number(saved?.left))
      ? Number(saved.left)
      : DEFAULT_QUICK_ACCESS_STATE.left,
    top: Number.isFinite(Number(saved?.top))
      ? Number(saved.top)
      : DEFAULT_QUICK_ACCESS_STATE.top,
    locked: saved?.locked !== false
  };
}

function clampQuickAccessPosition(element, state) {
  const rect = element.getBoundingClientRect();
  const maximumLeft = Math.max(0, window.innerWidth - rect.width);
  const maximumTop = Math.max(0, window.innerHeight - rect.height);
  return {
    ...state,
    left: clamp(Math.round(Number(state.left) || 0), 0, maximumLeft),
    top: clamp(Math.round(Number(state.top) || 0), 0, maximumTop)
  };
}

function positionQuickAccess(element, state) {
  const positioned = clampQuickAccessPosition(element, state);
  element.style.left = `${positioned.left}px`;
  element.style.top = `${positioned.top}px`;
  return positioned;
}

function updateQuickAccessLock(element, state) {
  const dragHandle = element.querySelector("[data-codd-quick-drag]");
  const lockButton = element.querySelector("[data-codd-quick-lock]");
  const lockIcon = lockButton?.querySelector("i");

  element.classList.toggle("codd-quick-access--locked", state.locked);
  element.classList.toggle("codd-quick-access--unlocked", !state.locked);
  if (dragHandle) dragHandle.disabled = state.locked;
  if (!lockButton) return;

  const title = state.locked
    ? localize("QuickAccess.UnlockPosition")
    : localize("QuickAccess.LockPosition");
  lockButton.title = title;
  lockButton.setAttribute("aria-label", title);
  lockButton.setAttribute("aria-pressed", String(state.locked));
  lockIcon?.classList.toggle("fa-lock", state.locked);
  lockIcon?.classList.toggle("fa-lock-open", !state.locked);
}

async function saveQuickAccessState(state) {
  await game.settings.set(MODULE_ID, "quickAccessState", {
    left: Math.round(state.left),
    top: Math.round(state.top),
    locked: Boolean(state.locked)
  });
}

function renderQuickAccess() {
  if (typeof document === "undefined") return;
  if (document.getElementById(`${MODULE_ID}-quick-access`)) return;

  let state = getQuickAccessState();
  const element = document.createElement("nav");
  element.id = `${MODULE_ID}-quick-access`;
  element.className = "codd-quick-access";
  element.setAttribute("aria-label", localize("QuickAccess.Label"));
  element.innerHTML = `
    ${game.user?.isGM ? `
      <div class="codd-quick-access__controls">
        <button
          type="button"
          class="codd-quick-access__control codd-quick-access__drag"
          data-codd-quick-drag
          title="${escapeHtml(localize("QuickAccess.Drag"))}"
          aria-label="${escapeHtml(localize("QuickAccess.Drag"))}"
        >
          <i class="fa-solid fa-grip-lines"></i>
        </button>
        <button
          type="button"
          class="codd-quick-access__control"
          data-codd-quick-lock
        >
          <i class="fa-solid fa-lock"></i>
        </button>
      </div>
    ` : ""}
    <button type="button" class="codd-quick-access__action" data-codd-open="records" title="${escapeHtml(localize("QuickAccess.Records"))}">
      <i class="fa-solid fa-book-skull"></i>
    </button>
    ${game.user?.isGM ? `
      <button type="button" class="codd-quick-access__action" data-codd-open="configuration" title="${escapeHtml(localize("QuickAccess.Configuration"))}">
        <i class="fa-solid fa-gears"></i>
      </button>
    ` : ""}
  `;
  document.body.append(element);
  state = positionQuickAccess(element, state);
  updateQuickAccessLock(element, state);

  element.querySelector('[data-codd-open="records"]')?.addEventListener(
    "click",
    () => openRecordsApplication()
  );
  element.querySelector('[data-codd-open="configuration"]')?.addEventListener(
    "click",
    () => openConfigurationApplication()
  );

  const lockButton = element.querySelector("[data-codd-quick-lock]");
  const dragHandle = element.querySelector("[data-codd-quick-drag]");
  lockButton?.addEventListener("click", async () => {
    state.locked = !state.locked;
    updateQuickAccessLock(element, state);
    try {
      await saveQuickAccessState(state);
    } catch (error) {
      console.error(`${MODULE_ID} | Could not save the quick-access lock.`, error);
      ui.notifications.error(localize("Notifications.QuickAccessSaveError"));
    }
  });

  dragHandle?.addEventListener("pointerdown", (event) => {
    if (state.locked || event.button !== 0) return;
    event.preventDefault();

    const pointerId = event.pointerId;
    const startRect = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    element.classList.add("codd-quick-access--dragging");
    dragHandle.setPointerCapture?.(pointerId);

    const move = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      state = positionQuickAccess(element, {
        ...state,
        left: startRect.left + moveEvent.clientX - startX,
        top: startRect.top + moveEvent.clientY - startY
      });
    };

    const finish = async (finishEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      element.classList.remove("codd-quick-access--dragging");
      dragHandle.releasePointerCapture?.(pointerId);
      try {
        await saveQuickAccessState(state);
      } catch (error) {
        console.error(`${MODULE_ID} | Could not save the quick-access position.`, error);
        ui.notifications.error(localize("Notifications.QuickAccessSaveError"));
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  });

  window.addEventListener("resize", () => {
    state = positionQuickAccess(element, state);
  });
}

function getAssociatedSpellFromDamageOptions(options) {
  let message = options?.originatingMessage ?? null;
  if (typeof message === "string") message = game.messages.get(message);
  if (!message) return null;

  const directItem = message.getAssociatedItem?.();
  if (directItem?.type === "spell") return directItem;

  const origin = message.getOriginatingMessage?.();
  const originItem = origin?.getAssociatedItem?.();
  return originItem?.type === "spell" ? originItem : null;
}

function reduceSpellHealing(actor, amount, updates, options) {
  if (!actor || Number(amount) >= 0) return;
  const healingScope = String(
    game.settings.get(MODULE_ID, "spellHealingScope") || "victims"
  );
  if (healingScope !== "everyone" && !getSelectedVictimIds().includes(actor.id)) {
    return;
  }

  const penalty = Math.max(
    0,
    Number(game.settings.get(MODULE_ID, "spellHealingPenalty")) || 0
  );
  if (penalty <= 0 || !getAssociatedSpellFromDamageOptions(options)) return;

  const hpPath = "system.attributes.hp.value";
  const currentHp = Number(actor.system?.attributes?.hp?.value);
  const updatedHp = Number(updates?.[hpPath]);
  if (!Number.isFinite(currentHp) || !Number.isFinite(updatedHp)) return;

  const healingApplied = Math.max(0, updatedHp - currentHp);
  const reduction = Math.min(penalty, healingApplied);
  if (reduction > 0) updates[hpPath] = updatedHp - reduction;
}

function buildRulesJournalContent() {
  const victimNames = getSelectedVictims().map((actor) => escapeHtml(actor.name)).join(", ");
  const victimIntervals = getVictimIntervals();
  const paladinChance = clamp(
    Number(game.settings.get(MODULE_ID, "paladinChance")) || 0,
    0,
    10
  );
  const interval = getGlobalIntervalDays();
  const loss = escapeHtml(game.settings.get(MODULE_ID, "abilityLossFormula") || "1d4");
  const healingPenalty = Math.max(
    0,
    Number(game.settings.get(MODULE_ID, "spellHealingPenalty")) || 0
  );
  const healingScope = String(
    game.settings.get(MODULE_ID, "spellHealingScope") || "victims"
  );
  const healingRule = healingScope === "everyone"
    ? "Rules.HealingEveryone"
    : "Rules.HealingVictims";
  const rollModeDescriptions = getSelectedVictims()
    .map((actor) => format("Rules.VictimRollMode", {
      actor: escapeHtml(actor.name),
      mode: escapeHtml(getRollModeLabel(getRollModeForActor(actor)))
    }))
    .join(" ");
  const intervalDescriptions = getSelectedVictims()
    .map((actor) => format("Rules.VictimInterval", {
      actor: escapeHtml(actor.name),
      interval: getIntervalDaysForActor(actor.id, victimIntervals)
    }))
    .join(" ");

  return `
    <section class="codd-rules">
      <h1>${escapeHtml(localize("Rules.Title"))}</h1>
      <p>${escapeHtml(localize("Rules.Introduction"))}</p>
      <h2>${escapeHtml(localize("Rules.AttackHeading"))}</h2>
      <ol>
        <li>${format("Rules.PaladinCheck", { chance: paladinChance })}</li>
        <li>${format("Rules.PaladinSelfAura", { level: PALADIN_SELF_AURA_LEVEL })}</li>
        <li>${escapeHtml(localize("Rules.AbilityCheck"))}</li>
        <li>${escapeHtml(localize("Rules.Save"))}</li>
        <li>${format("Rules.Failure", { formula: loss })}</li>
      </ol>
      <h2>${escapeHtml(localize("Rules.CriticalHeading"))}</h2>
      <ul>
        <li>${escapeHtml(localize("Rules.NaturalOne"))}</li>
        <li>${escapeHtml(localize("Rules.NaturalTwenty"))}</li>
      </ul>
      <h2>${escapeHtml(localize("Rules.HealingHeading"))}</h2>
      <p>${format(healingRule, { penalty: healingPenalty })}</p>
      <p>${escapeHtml(localize("Rules.HealingExceptions"))}</p>
      <h2>${escapeHtml(localize("Rules.CurrentHeading"))}</h2>
      <ul>
        <li>${format("Rules.Victims", {
          victims: victimNames || escapeHtml(localize("Rules.NoVictims"))
        })}</li>
        <li>${format("Rules.GlobalInterval", { interval })}</li>
        <li>${format("Rules.VictimIntervals", {
          intervals: intervalDescriptions || escapeHtml(localize("Rules.NoVictims"))
        })}</li>
        <li>${format("Rules.RollModes", {
          modes: rollModeDescriptions || escapeHtml(localize("Rules.NoVictims"))
        })}</li>
        <li>${escapeHtml(localize("Rules.NpcRolls"))}</li>
        <li>${escapeHtml(localize("Rules.ChatPermissions"))}</li>
        <li>${escapeHtml(localize("Rules.Records"))}</li>
      </ul>
      <p><em>${escapeHtml(localize("Rules.NoExactDate"))}</em></p>
      <h2>${escapeHtml(localize("Rules.RemovalHeading"))}</h2>
      <p>${escapeHtml(localize("Rules.Removal"))}</p>
    </section>
  `;
}

async function ensureRulesJournal() {
  if (!isPrimaryGM() || typeof JournalEntry === "undefined") return null;

  const journalName = localize("Rules.JournalName");
  const pageName = localize("Rules.PageName");
  const content = buildRulesJournalContent();
  const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER ?? 2;
  const htmlFormat = CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1;

  let journal = game.journal?.find(
    (entry) => entry.getFlag(MODULE_ID, RULES_JOURNAL_FLAG)
  ) ?? null;

  if (!journal) {
    journal = await JournalEntry.create({
      name: journalName,
      img: ICON_PATH,
      ownership: { default: observer },
      flags: {
        [MODULE_ID]: {
          [RULES_JOURNAL_FLAG]: true
        }
      },
      pages: [{
        name: pageName,
        type: "text",
        text: {
          content,
          format: htmlFormat
        },
        flags: {
          [MODULE_ID]: {
            [RULES_PAGE_FLAG]: true
          }
        }
      }]
    });
    return journal;
  }

  const journalUpdates = {};
  if (journal.name !== journalName) journalUpdates.name = journalName;
  if (journal.img !== ICON_PATH) journalUpdates.img = ICON_PATH;
  if (Number(journal.ownership?.default) < observer) {
    journalUpdates["ownership.default"] = observer;
  }
  if (Object.keys(journalUpdates).length) await journal.update(journalUpdates);

  let page = journal.pages?.find(
    (entryPage) => entryPage.getFlag(MODULE_ID, RULES_PAGE_FLAG)
  ) ?? journal.pages?.find((entryPage) => entryPage.type === "text") ?? null;

  if (!page) {
    [page] = await journal.createEmbeddedDocuments("JournalEntryPage", [{
      name: pageName,
      type: "text",
      text: {
        content,
        format: htmlFormat
      },
      flags: {
        [MODULE_ID]: {
          [RULES_PAGE_FLAG]: true
        }
      }
    }]);
  } else {
    const pageUpdates = {};
    if (page.name !== pageName) pageUpdates.name = pageName;
    if (page.text?.content !== content) pageUpdates["text.content"] = content;
    if (!page.getFlag(MODULE_ID, RULES_PAGE_FLAG)) {
      pageUpdates[`flags.${MODULE_ID}.${RULES_PAGE_FLAG}`] = true;
    }
    if (Object.keys(pageUpdates).length) await page.update(pageUpdates);
  }

  return journal;
}

function scheduleRulesJournalUpdate() {
  if (!game.ready || !isPrimaryGM()) return;
  clearTimeout(journalUpdateTimer);
  journalUpdateTimer = setTimeout(() => {
    ensureRulesJournal().catch((error) => {
      console.error(`${MODULE_ID} | Could not update the rules journal.`, error);
    });
  }, 250);
}

function registerSettings() {
  game.settings.registerMenu(MODULE_ID, "configurationMenu", {
    name: "CODD.Settings.Configuration.Name",
    label: "CODD.Settings.Configuration.Label",
    hint: "CODD.Settings.Configuration.Hint",
    icon: "fa-solid fa-skull",
    type: CurseConfiguration,
    restricted: true
  });

  game.settings.register(MODULE_ID, "saveDC", {
    name: "CODD.Settings.SaveDC.Name",
    hint: "CODD.Settings.SaveDC.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 18,
    range: {
      min: 1,
      max: 30,
      step: 1
    },
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "paladinChance", {
    name: "CODD.Settings.PaladinChance.Name",
    hint: "CODD.Settings.PaladinChance.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 5,
    range: {
      min: 0,
      max: 10,
      step: 1
    },
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "fallbackAuraBonus", {
    name: "CODD.Settings.FallbackAuraBonus.Name",
    hint: "CODD.Settings.FallbackAuraBonus.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
    range: {
      min: 0,
      max: 10,
      step: 1
    },
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "intervalDays", {
    name: "CODD.Settings.IntervalDays.Name",
    hint: "CODD.Settings.IntervalDays.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
    range: {
      min: 1,
      max: 365,
      step: 1
    },
    onChange: () => {
      scheduleRulesJournalUpdate();
      if (suppressGlobalIntervalReset || !game.ready || !isPrimaryGM()) return;
      resetInheritedVictimSchedulesFromNow().then(() => {
        ui.notifications.info(localize("Notifications.GlobalScheduleReset"));
      });
    }
  });

  game.settings.register(MODULE_ID, "abilityLossFormula", {
    name: "CODD.Settings.AbilityLossFormula.Name",
    hint: "CODD.Settings.AbilityLossFormula.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "1d4",
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "rollMode", {
    name: "CODD.Settings.RollMode.Name",
    hint: "CODD.Settings.RollMode.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      publicroll: "CODD.RollMode.Public",
      gmroll: "CODD.RollMode.Private",
      blindroll: "CODD.RollMode.Blind",
      selfroll: "CODD.RollMode.Self"
    },
    default: "publicroll",
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "spellHealingPenalty", {
    name: "CODD.Settings.SpellHealingPenalty.Name",
    hint: "CODD.Settings.SpellHealingPenalty.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 3,
    range: {
      min: 0,
      max: 20,
      step: 1
    },
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "spellHealingScope", {
    name: "CODD.Settings.SpellHealingScope.Name",
    hint: "CODD.Settings.SpellHealingScope.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      victims: "CODD.Settings.SpellHealingScope.Victims",
      everyone: "CODD.Settings.SpellHealingScope.Everyone"
    },
    default: "victims",
    onChange: scheduleRulesJournalUpdate
  });

  game.settings.register(MODULE_ID, "victimActorIds", {
    scope: "world",
    config: false,
    type: Array,
    default: []
  });

  game.settings.register(MODULE_ID, "paladinActorId", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });

  game.settings.register(MODULE_ID, "victimSchedules", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "victimIntervals", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "victimRollModes", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "victimRecords", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "victimRecordShares", {
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, "quickAccessState", {
    scope: "client",
    config: false,
    type: Object,
    default: DEFAULT_QUICK_ACCESS_STATE
  });

  // Retained only to migrate schedules created by versions before 0.2.0.
  game.settings.register(MODULE_ID, "nextAttackTimestamp", {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
}

function activateChatCardListeners(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  const data = getAttackFlag(message);
  if (!data) return;

  const actor = game.actors.get(data.actorId);
  const allowed = canControlActor(actor);
  for (const button of root.querySelectorAll("[data-codd-action]")) {
    if (!allowed) {
      button.hidden = true;
      continue;
    }

    button.addEventListener("click", () => {
      const action = button.dataset.coddAction;
      button.disabled = true;
      button.classList.add("codd-action--working");
      requestAction(action, message.id);
    });
  }
}

function registerCalendarHooks() {
  if (calendarHooksRegistered) return;
  calendarHooksRegistered = true;

  const simpleCalendar = getSimpleCalendar();
  const dateTimeHook = simpleCalendar?.Hooks?.DateTimeChange ?? SC_DATE_TIME_HOOK;
  const readyHook = simpleCalendar?.Hooks?.Ready ?? SC_READY_HOOK;
  const primaryHook = simpleCalendar?.Hooks?.PrimaryGM ?? SC_PRIMARY_GM_HOOK;

  Hooks.on(dateTimeHook, () => processCalendarDateChange());
  Hooks.on(readyHook, async () => {
    await ensureVictimSchedules();
    await processCalendarDateChange();
  });
  Hooks.on(primaryHook, async (data) => {
    if (!data?.isPrimaryGM) return;
    await ensureVictimSchedules();
    await ensureRulesJournal();
    await processCalendarDateChange();
  });
}

Hooks.once("init", () => {
  registerSettings();
  Hooks.on("dnd5e.preApplyDamage", reduceSpellHealing);
  Hooks.on("renderSceneControls", renderQuickAccess);
});

Hooks.once("ready", async () => {
  game.socket.on(SOCKET_NAME, (payload) => {
    handleActionRequest(payload).catch((error) => {
      console.error(`${MODULE_ID} | Socket action failed.`, error);
      if (isPrimaryGM()) ui.notifications.error(localize("Notifications.ActionError"));
    });
  });

  Hooks.on("renderChatMessage", activateChatCardListeners);
  registerCalendarHooks();
  renderQuickAccess();

  if (game.system.id !== "dnd5e") {
    ui.notifications.error(localize("Notifications.WrongSystem"));
    return;
  }

  if (!game.modules.get("foundryvtt-simple-calendar-reborn")?.active) {
    ui.notifications.error(localize("Notifications.CalendarMissing"));
    return;
  }

  await ensureVictimSchedules();
  await ensureRulesJournal();
  setTimeout(() => processCalendarDateChange(), 6000);

  game.modules.get(MODULE_ID).api = {
    createAttackCards: () => requestAction("manualAttackAll"),
    resetSchedule: () => requestAction("resetSchedule"),
    removeManagedCurseEffects,
    removeManagedDrainEffects: removeManagedCurseEffects,
    getSelectedVictims,
    ensureRulesJournal,
    openConfiguration: openConfigurationApplication,
    openRecords: openRecordsApplication,
    getCurseRecords
  };
});
