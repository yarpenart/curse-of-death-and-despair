const MODULE_ID = "curse-of-death-and-despair";
const SOCKET_NAME = `module.${MODULE_ID}`;
const ICON_PATH = `modules/${MODULE_ID}/assets/curse.svg`;
const SC_DATE_TIME_HOOK = "simple-calendar-date-time-change";
const SC_READY_HOOK = "simple-calendar-ready";
const SC_PRIMARY_GM_HOOK = "simple-calendar-primary-gm";
const MAX_MISSED_CYCLES = 20;

const ABILITY_BY_D6 = Object.freeze({
  1: "str",
  2: "dex",
  3: "con",
  4: "int",
  5: "wis",
  6: "cha"
});

let calendarProcessing = false;
let calendarHooksRegistered = false;

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
  const characters = worldActors.filter((actor) => actor?.type === "character");

  // D&D5e characters are normally type "character". If a world uses a custom
  // actor subtype, keep the configuration usable instead of showing a blank list.
  return characters.length ? characters : worldActors;
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

async function setNextAttackFromNow() {
  if (!isPrimaryGM()) return null;

  const simpleCalendar = getSimpleCalendar();
  if (!simpleCalendar?.api?.currentDateTime
    || !simpleCalendar?.api?.dateToTimestamp
    || !simpleCalendar?.api?.timestampPlusInterval) {
    return null;
  }

  const current = simpleCalendar.api.currentDateTime();
  if (!current) return null;

  const startOfCurrentDay = simpleCalendar.api.dateToTimestamp({
    year: current.year,
    month: current.month,
    day: current.day,
    hour: 0,
    minute: 0,
    seconds: 0
  });
  const intervalDays = Math.max(1, Number(game.settings.get(MODULE_ID, "intervalDays")) || 1);
  const nextTimestamp = simpleCalendar.api.timestampPlusInterval(
    startOfCurrentDay,
    { day: intervalDays }
  );

  await game.settings.set(MODULE_ID, "nextAttackTimestamp", nextTimestamp);
  return nextTimestamp;
}

async function ensureSchedule() {
  if (!isPrimaryGM()) return;
  const current = Number(game.settings.get(MODULE_ID, "nextAttackTimestamp"));
  if (Number.isFinite(current) && current !== 0) return;
  await setNextAttackFromNow();
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
        ${cardStat(localize("Card.Paladin"), `${data.proximityRoll}/20`, auraTone)}
        ${cardStat(localize("Card.Aura"), auraText, auraTone)}
        ${cardStat(localize("Card.AttackedAbility"), `${data.abilityRoll}: ${abilityLabel}`)}
        ${cardStat(localize("Card.SaveDC"), data.dc)}
      </div>
    `;
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

      if (data.deathThresholdReached) {
        body += `
          <div class="codd-death">
            <i class="fa-solid fa-skull-crossbones"></i>
            <span>${format("Card.DeathThreshold", { actor: actorName, ability: abilityLabel })}</span>
          </div>
        `;
      }
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
    version: 1,
    actorId: actor.id,
    actorName: actor.name,
    scheduledTimestamp,
    manual,
    state: "pending",
    dc: Math.max(1, Number(game.settings.get(MODULE_ID, "saveDC")) || 18),
    paladinChance: Math.clamp(
      Number(game.settings.get(MODULE_ID, "paladinChance")) || 0,
      0,
      20
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
    await ensureSchedule();

    const now = Number(simpleCalendar.api.timestamp());
    let next = Number(game.settings.get(MODULE_ID, "nextAttackTimestamp"));
    const intervalDays = Math.max(1, Number(game.settings.get(MODULE_ID, "intervalDays")) || 1);
    if (!Number.isFinite(now) || !Number.isFinite(next) || next === 0) return;

    let cycles = 0;
    while (now >= next && cycles < MAX_MISSED_CYCLES) {
      await createAttackCardsForVictims(next);
      next = Number(simpleCalendar.api.timestampPlusInterval(next, { day: intervalDays }));
      cycles += 1;
    }

    if (cycles === MAX_MISSED_CYCLES && now >= next) {
      console.warn(`${MODULE_ID} | More than ${MAX_MISSED_CYCLES} curse cycles were skipped; advancing the schedule without creating additional cards.`);
      while (now >= next) {
        next = Number(simpleCalendar.api.timestampPlusInterval(next, { day: intervalDays }));
      }
      ui.notifications.warn(localize("Notifications.MissedCyclesCapped"));
    }

    if (cycles > 0) {
      await game.settings.set(MODULE_ID, "nextAttackTimestamp", next);
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
      "1d20",
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
    const ability = ABILITY_BY_D6[Math.clamp(Number(abilityRoll.total), 1, 6)];

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

async function rollSavingThrow(actor, ability, dc, auraBonus) {
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
      { ability, target: dc },
      {},
      { data: { speaker: getActorSpeaker(actor) } }
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

async function evaluateLossFormula(formula, actor) {
  try {
    const roll = await rollToChat(
      formula,
      format("Rolls.AbilityLoss", { actor: actor.name }),
      actor
    );
    return Math.max(0, Math.floor(Number(roll.total) || 0));
  } catch (error) {
    console.error(`${MODULE_ID} | Invalid ability loss formula "${formula}". Falling back to 1d4.`, error);
    ui.notifications.warn(format("Notifications.InvalidLossFormula", { formula }));
    const fallback = await rollToChat(
      "1d4",
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

  try {
    const roll = await rollSavingThrow(
      actor,
      data.ability,
      data.dc,
      data.paladinNear ? data.auraBonus : 0
    );

    if (!roll || !Number.isFinite(Number(roll.total))) {
      data.state = "ready";
      await updateAttackMessage(message, data);
      ui.notifications.warn(localize("Notifications.SaveCancelled"));
      return;
    }

    const saveTotal = Number(roll.total);
    const success = saveTotal >= data.dc;
    Object.assign(data, {
      state: "resolved",
      success,
      saveTotal
    });

    if (!success) {
      const lossRolled = await evaluateLossFormula(data.lossFormula, actor);
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
    await setNextAttackFromNow();
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

async function removeManagedDrainEffects(actorIds = getSelectedVictimIds()) {
  if (!game.user.isGM) return;

  const victims = actorIds
    .map((id) => game.actors.get(id))
    .filter(Boolean);
  let removed = 0;
  for (const actor of victims) {
    const effectIds = actor.effects
      .filter((effect) => effect.getFlag(MODULE_ID, "managedDrain"))
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
      width: 560,
      height: "auto",
      closeOnSubmit: true
    });
  }

  getData() {
    const selectedIds = new Set(getSelectedVictimIds());
    const selectedPaladinId = game.settings.get(MODULE_ID, "paladinActorId");
    const availableActors = getConfigurableActors()
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")))
      .map((actor) => ({
        id: actor.id,
        name: actor.name ?? localize("Card.UnknownActor"),
        img: actor.img ?? "icons/svg/mystery-man.svg",
        selected: selectedIds.has(actor.id),
        paladin: isPaladinActor(actor),
        effect: getManagedDrainEffect(actor)?.name ?? ""
      }));

    const paladins = availableActors.map((actor) => ({
      ...actor,
      chosen: actor.id === selectedPaladinId
    }));

    const nextTimestamp = Number(game.settings.get(MODULE_ID, "nextAttackTimestamp"));
    return {
      availableActors,
      hasAvailableActors: availableActors.length > 0,
      paladins,
      nextAttack: nextTimestamp
        ? formatCalendarTimestamp(nextTimestamp)
        : localize("Config.NotScheduled")
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
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
      await removeManagedDrainEffects(actorIds);
      this.render();
    });
  }

  async _updateObject(event, formData) {
    const form = event.currentTarget;
    const victimIds = Array.from(
      form.querySelectorAll('input[name="victims"]:checked')
    ).map((input) => input.value);
    const paladinActorId = String(formData.paladinActorId ?? "");

    await game.settings.set(MODULE_ID, "victimActorIds", victimIds);
    await game.settings.set(MODULE_ID, "paladinActorId", paladinActorId);
    await ensureSchedule();
    ui.notifications.info(localize("Notifications.ConfigurationSaved"));
  }
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
    }
  });

  game.settings.register(MODULE_ID, "paladinChance", {
    name: "CODD.Settings.PaladinChance.Name",
    hint: "CODD.Settings.PaladinChance.Hint",
    scope: "world",
    config: true,
    type: Number,
    default: 10,
    range: {
      min: 0,
      max: 20,
      step: 1
    }
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
    }
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
      if (!game.ready || !isPrimaryGM()) return;
      setNextAttackFromNow().then(() => {
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
    default: "1d4"
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
      button.disabled = true;
      button.title = localize("Notifications.NotOwner");
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
    await ensureSchedule();
    await processCalendarDateChange();
  });
  Hooks.on(primaryHook, async (data) => {
    if (!data?.isPrimaryGM) return;
    await ensureSchedule();
    await processCalendarDateChange();
  });
}

Hooks.once("init", () => {
  registerSettings();
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

  await ensureSchedule();
  setTimeout(() => processCalendarDateChange(), 6000);

  game.modules.get(MODULE_ID).api = {
    createAttackCards: () => requestAction("manualAttackAll"),
    resetSchedule: () => requestAction("resetSchedule"),
    removeManagedDrainEffects,
    getSelectedVictims
  };
});
