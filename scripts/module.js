const MODULE_ID = "curse-of-death-and-despair";
const SOCKET_NAME = `module.${MODULE_ID}`;
const ICON_PATH = `modules/${MODULE_ID}/assets/curse.svg`;
const SC_DATE_TIME_HOOK = "simple-calendar-date-time-change";
const SC_READY_HOOK = "simple-calendar-ready";
const SC_PRIMARY_GM_HOOK = "simple-calendar-primary-gm";
const MAX_MISSED_CYCLES = 20;
const RULES_JOURNAL_FLAG = "rulesJournal";
const RULES_PAGE_FLAG = "rulesPage";

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
  return actor?.items?.some((item) => {
    if (item.type !== "class") return false;
    const identifier = String(item.system?.identifier ?? "").toLowerCase();
    const name = String(item.name ?? "").toLowerCase();
    return identifier === "paladin"
      || name.includes("paladin")
      || name.includes("paladyn");
  });
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
  const configured = String(game.settings.get(MODULE_ID, "rollMode") || "publicroll");
  return Object.hasOwn(ROLL_MODE_LABELS, configured) ? configured : "publicroll";
}

function getRollModeLabel(mode) {
  return localize(ROLL_MODE_LABELS[mode] ?? ROLL_MODE_LABELS.publicroll);
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

function getDefaultNextTimestamp() {
  const simpleCalendar = getSimpleCalendar();
  const start = getStartOfCurrentDay();
  if (!Number.isFinite(start) || !simpleCalendar?.api?.timestampPlusInterval) return 0;

  const intervalDays = Math.max(1, Number(game.settings.get(MODULE_ID, "intervalDays")) || 1);
  return Number(simpleCalendar.api.timestampPlusInterval(start, { day: intervalDays }));
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
  const legacy = Number(game.settings.get(MODULE_ID, "nextAttackTimestamp"));
  const fallback = Number.isFinite(legacy) && legacy > 0
    ? legacy
    : getDefaultNextTimestamp();
  const next = {};

  for (const actorId of victimIds) {
    const existing = Number(current[actorId]);
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
  const nextTimestamp = getDefaultNextTimestamp();
  const schedules = Object.fromEntries(
    getSelectedVictimIds().map((actorId) => [actorId, nextTimestamp])
  );
  await game.settings.set(MODULE_ID, "victimSchedules", schedules);
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

    body = `
      <div class="codd-stats">
        ${cardStat(localize("Card.Paladin"), `${data.proximityRoll}/10`, auraTone)}
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
    version: 2,
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

  return ChatMessage.create({
    user: game.user.id,
    speaker: getActorSpeaker(actor),
    content: renderAttackCard(data),
    flags: {
      [MODULE_ID]: {
        attack: data
      }
    }
  });
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
    const intervalDays = Math.max(1, Number(game.settings.get(MODULE_ID, "intervalDays")) || 1);
    if (!Number.isFinite(now)) return;

    let changed = false;
    let capped = false;
    for (const actor of getSelectedVictims()) {
      let next = Number(schedules[actor.id]);
      if (!Number.isFinite(next)) continue;

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

  data.state = "determining";
  await updateAttackMessage(message, data);

  try {
    const proximityRoll = await rollToChat(
      "1d10",
      format("Rolls.PaladinProximity", { actor: actor.name, target: data.paladinChance }),
      actor
    );
    const paladinNear = proximityRoll.total <= data.paladinChance;
    const aura = paladinNear ? getAuraDetails() : { bonus: 0, source: "", actorId: null };

    const abilityRoll = await rollToChat(
      "1d6",
      format("Rolls.AbilityTarget", { actor: actor.name }),
      actor
    );
    const ability = ABILITY_BY_D6[clamp(Number(abilityRoll.total), 1, 6)];

    Object.assign(data, {
      state: "ready",
      proximityRoll: proximityRoll.total,
      paladinNear,
      auraBonus: aura.bonus,
      auraSource: aura.source,
      auraActorId: aura.actorId,
      abilityRoll: abilityRoll.total,
      ability
    });
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

function getCalendarMonths() {
  const simpleCalendar = getSimpleCalendar();
  try {
    const months = simpleCalendar?.api?.getAllMonths?.() ?? [];
    return months.map((month, index) => ({
      value: index,
      name: month.name ?? String(index + 1),
      days: Number(month.numberOfDays) || 31
    }));
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not read calendar months.`, error);
    return [];
  }
}

function getScheduleParts(timestamp) {
  const simpleCalendar = getSimpleCalendar();
  const fallback = simpleCalendar?.api?.currentDateTime?.() ?? {
    year: 0,
    month: 0,
    day: 0
  };
  try {
    return simpleCalendar?.api?.timestampToDate?.(timestamp) ?? fallback;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not convert a victim schedule.`, error);
    return fallback;
  }
}

class CurseConfiguration extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: `${MODULE_ID}-configuration`,
      title: localize("Config.Title"),
      template: `modules/${MODULE_ID}/templates/configuration.hbs`,
      width: 580,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    const selectedIds = new Set(getSelectedVictimIds());
    const selectedPaladinId = game.settings.get(MODULE_ID, "paladinActorId");
    const schedules = getVictimSchedules();
    const defaultTimestamp = getDefaultNextTimestamp();
    const calendarMonths = getCalendarMonths();
    const availableActors = getConfigurableActors()
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
      .map((actor) => {
        const storedTimestamp = Number(schedules[actor.id]);
        const timestamp = Object.hasOwn(schedules, actor.id) && Number.isFinite(storedTimestamp)
          ? storedTimestamp
          : defaultTimestamp;
        const date = getScheduleParts(timestamp);
        const months = calendarMonths.map((month) => ({
          ...month,
          selected: month.value === Number(date.month)
        }));
        const selectedMonthDays = months.find((month) => month.selected)?.days ?? 31;
        return {
          id: actor.id,
          name: actor.name ?? localize("Card.UnknownActor"),
          img: actor.img ?? "icons/svg/mystery-man.svg",
          selected: selectedIds.has(actor.id),
          paladin: isPaladinActor(actor),
          effect: getManagedDrainEffect(actor)?.name ?? "",
          schedule: formatCalendarTimestamp(timestamp),
          year: Number(date.year),
          day: Number(date.day) + 1,
          selectedMonthDays,
          months
        };
      });

    const paladins = availableActors.map((actor) => ({
      ...actor,
      chosen: actor.id === selectedPaladinId
    }));

    return {
      availableActors,
      hasAvailableActors: availableActors.length > 0,
      paladins
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    const syncScheduleControls = (checkbox) => {
      const row = checkbox.closest("[data-codd-actor]");
      for (const input of row?.querySelectorAll("[data-codd-schedule-input]") ?? []) {
        input.disabled = !checkbox.checked;
      }
    };
    html.find('input[name="victims"]').each((_, checkbox) => {
      syncScheduleControls(checkbox);
      checkbox.addEventListener("change", () => syncScheduleControls(checkbox));
    });

    html.find("[data-codd-month]").on("change", (event) => {
      const month = event.currentTarget;
      const option = month.selectedOptions?.[0];
      const row = month.closest("[data-codd-actor]");
      const day = row?.querySelector("[data-codd-day]");
      if (!day || !option) return;
      day.max = option.dataset.days;
      day.value = String(Math.min(Number(day.value) || 1, Number(day.max) || 31));
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
  }

  async _updateObject(event, formData) {
    const form = event.currentTarget;
    const victimIds = Array.from(
      form.querySelectorAll('input[name="victims"]:checked')
    ).map((input) => input.value);
    const paladinActorId = String(formData.paladinActorId ?? "");
    const currentSchedules = getVictimSchedules();
    const victimSchedules = {};
    const simpleCalendar = getSimpleCalendar();

    for (const actorId of victimIds) {
      const row = Array.from(form.querySelectorAll("[data-codd-actor]"))
        .find((element) => element.dataset.coddActor === actorId);
      const year = Number(row?.querySelector("[data-codd-year]")?.value);
      const month = Number(row?.querySelector("[data-codd-month]")?.value);
      const day = Number(row?.querySelector("[data-codd-day]")?.value) - 1;

      try {
        const timestamp = Number(simpleCalendar?.api?.dateToTimestamp?.({
          year,
          month,
          day,
          hour: 0,
          minute: 0,
          seconds: 0
        }));
        const previous = Number(currentSchedules[actorId]);
        victimSchedules[actorId] = Number.isFinite(timestamp)
          ? timestamp
          : (Number.isFinite(previous) ? previous : getDefaultNextTimestamp());
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not save schedule for actor ${actorId}.`, error);
        const previous = Number(currentSchedules[actorId]);
        victimSchedules[actorId] = Number.isFinite(previous)
          ? previous
          : getDefaultNextTimestamp();
      }
    }

    await game.settings.set(MODULE_ID, "victimActorIds", victimIds);
    await game.settings.set(MODULE_ID, "paladinActorId", paladinActorId);
    await game.settings.set(MODULE_ID, "victimSchedules", victimSchedules);
    await ensureVictimSchedules();
    await ensureRulesJournal();
    ui.notifications.info(localize("Notifications.ConfigurationSaved"));
  }
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
  if (!getSelectedVictimIds().includes(actor.id)) return;

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
  const paladinChance = clamp(
    Number(game.settings.get(MODULE_ID, "paladinChance")) || 0,
    0,
    10
  );
  const dc = Math.max(1, Number(game.settings.get(MODULE_ID, "saveDC")) || 18);
  const interval = Math.max(1, Number(game.settings.get(MODULE_ID, "intervalDays")) || 1);
  const loss = escapeHtml(game.settings.get(MODULE_ID, "abilityLossFormula") || "1d4");
  const healingPenalty = Math.max(
    0,
    Number(game.settings.get(MODULE_ID, "spellHealingPenalty")) || 0
  );
  const rollMode = getRollModeLabel(
    String(game.settings.get(MODULE_ID, "rollMode") || "publicroll")
  );

  return `
    <section class="codd-rules">
      <h1>${escapeHtml(localize("Rules.Title"))}</h1>
      <p>${escapeHtml(localize("Rules.Introduction"))}</p>
      <h2>${escapeHtml(localize("Rules.AttackHeading"))}</h2>
      <ol>
        <li>${format("Rules.PaladinCheck", { chance: paladinChance })}</li>
        <li>${escapeHtml(localize("Rules.AbilityCheck"))}</li>
        <li>${format("Rules.Save", { dc })}</li>
        <li>${format("Rules.Failure", { formula: loss })}</li>
      </ol>
      <h2>${escapeHtml(localize("Rules.CriticalHeading"))}</h2>
      <ul>
        <li>${escapeHtml(localize("Rules.NaturalOne"))}</li>
        <li>${escapeHtml(localize("Rules.NaturalTwenty"))}</li>
      </ul>
      <h2>${escapeHtml(localize("Rules.HealingHeading"))}</h2>
      <p>${format("Rules.Healing", { penalty: healingPenalty })}</p>
      <p>${escapeHtml(localize("Rules.HealingExceptions"))}</p>
      <h2>${escapeHtml(localize("Rules.CurrentHeading"))}</h2>
      <ul>
        <li>${format("Rules.Victims", {
          victims: victimNames || escapeHtml(localize("Rules.NoVictims"))
        })}</li>
        <li>${format("Rules.Interval", { interval })}</li>
        <li>${format("Rules.RollMode", { mode: escapeHtml(rollMode) })}</li>
        <li>${escapeHtml(localize("Rules.NpcRolls"))}</li>
        <li>${escapeHtml(localize("Rules.ChatPermissions"))}</li>
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
      if (!game.ready || !isPrimaryGM()) return;
      resetVictimSchedulesFromNow().then(() => {
        ui.notifications.info(localize("Notifications.ScheduleReset"));
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
    ensureRulesJournal
  };
});
