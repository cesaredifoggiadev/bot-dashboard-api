import { FirestoreService } from './firestoreService';
import { ScuderiaExtensions } from './scuderiaExtensions';
import { RegiaAdaptiva } from './regiaAdaptiva';
import { OutcomeInferer } from './outcomeInferer';
import {
  ProactiveSettings,
  Advice,
  RowState,
  LastInput,
  GlobalState,
  DEFAULT_SETTINGS
} from './types';

export class ProactiveEngine {
  private scuderia: ScuderiaExtensions;
  private regiaDynamic: RegiaAdaptiva;

  constructor(
    private firestoreService: FirestoreService,
    private settings: ProactiveSettings
  ) {
    this.scuderia = new ScuderiaExtensions(firestoreService);
    this.regiaDynamic = new RegiaAdaptiva(firestoreService, settings);
  }

  async initialize(): Promise<void> {
    await this.regiaDynamic.initialize(1500, 540);
  }

  async getHeavyCount(): Promise<number> {
    const state = await this.firestoreService.getGlobalState();
    return state.heavyCount;
  }

  getSettings(): ProactiveSettings {
    return this.settings;
  }

  async setK(k: number): Promise<void> {
    if (k <= 0) throw new Error('K must be greater than zero');
    this.settings.k = k;
    await this.firestoreService.updateSettings({ k });
  }

  getK(): number {
    return this.settings.k;
  }

  async getHistory(tableId: number): Promise<string[]> {
    const tableState = await this.firestoreService.getTableState(tableId);
    return tableState.rowState.history;
  }

  getRegiaAdaptive(): RegiaAdaptiva {
    return this.regiaDynamic;
  }

  private async checkPreemptiveStopL5(tableId: number): Promise<Advice | null> {
    const globalState = await this.firestoreService.getGlobalState();
    const regiaParams = this.getRegiaParams(globalState.globalMarginUnits);
    
    const capResidua = await this.estimateResidualCapacityUnits();
    const triggerDebt = globalState.portfolioDebtUnits > this.settings.debtTriggerRatio * capResidua;
    const roomClosed = globalState.heavyCount >= regiaParams.hmax || globalState.cooldown > 0;

    if (roomClosed || triggerDebt) {
      await this.firestoreService.updateGlobalState({
        cooldown: Math.max(globalState.cooldown, regiaParams.cdn)
      });

      return {
        tableId,
        levelIndex: 4,
        stakeUnits: 0,
        stopAtL5: true,
        authorizedHeavy: false,
        reason: 'Stop L5 sync',
        globalMargin: Math.round(globalState.globalMarginUnits * this.settings.k * 100) / 100,
        signalW10: 'Green',
        signalTableW10: 'Green',
        hotZone: false,
        tooltipJson: '',
        hotZoneLabel: '',
        portfolioDebtUnits: globalState.portfolioDebtUnits,
        hotOverridesActive: globalState.hotOverridesActive,
        hotOverridesUsedThisShoe: globalState.hotOverridesUsedThisShoe,
        vmLocal20: 0,
        prediction: 'Stop L5',
        tableStatus: '🟢 Active'
      };
    }

    return null;
  }

  private getRegiaParams(globalMarginUnits: number): { hmax: number; cdn: number } {
    if (globalMarginUnits >= this.settings.highThresh) {
      return { hmax: this.settings.hmaxHigh, cdn: this.settings.cooldownHigh };
    }
    if (globalMarginUnits <= this.settings.lowThresh) {
      return { hmax: this.settings.hmaxLow, cdn: this.settings.cooldownLow };
    }
    return { hmax: this.settings.hmaxMid, cdn: this.settings.cooldownMid };
  }

  private inHotZone(handNo: number, bHotZone: boolean): boolean {
    if (!bHotZone) return false;
    for (const zone of this.settings.hotZones) {
      if (handNo >= zone.start && handNo <= zone.end) return true;
    }
    return false;
  }

  private getHotZoneLabel(handNo: number): string {
    for (const zone of this.settings.hotZones) {
      if (handNo >= zone.start && handNo <= zone.end) {
        return `Closed ${zone.start}-${zone.end}`;
      }
    }
    return `Open Zone ${handNo}`;
  }

  private async estimateResidualCapacityUnits(): Promise<number> {
    // Conta tabelle attive (approssimazione basata su conteggio documenti)
    const activeTables = Math.max(1, 10); // TODO: implementare conteggio reale se necessario
    return this.settings.meanUnitsPerHandPerTable * this.settings.estimatedHandsLeftPerTable * activeTables;
  }

  private getMaxRunP(rs: RowState): number {
    let max = 0;
    let cur = 0;
    for (const o of rs.history) {
      if (o === 'P') {
        cur++;
        if (cur > max) max = cur;
      } else {
        cur = 0;
      }
    }
    return max;
  }

  async feedAndDecide(
    tableId: number,
    handIndexMazzo: number,
    margineK: number,
    martingalaUi: number,
    bSignalW10: boolean,
    bHotZone: boolean,
    esito: string,
    totalElapsedMinutes: number,
    totaltables: number
  ): Promise<Advice> {
    // Carica stato tabella
    const tableState = await this.firestoreService.getTableState(tableId);
    const rs = tableState.rowState;

    // Validation
    const invalid =
      tableId <= 0 ||
      handIndexMazzo <= 0 ||
      isNaN(margineK) ||
      !isFinite(margineK) ||
      martingalaUi < 1;

    // Check duplicate input
    const keySeen = await this.firestoreService.isInputSeen(tableId, handIndexMazzo);

    if (keySeen && tableState.lastAdvice && tableState.lastInput) {
      const lastIn = tableState.lastInput;
      const sameHand = lastIn.handIndex === handIndexMazzo;
      const sameMargine = lastIn.margineK === margineK;
      const sameMartingala = lastIn.martingalaUi === martingalaUi;
      const sameEsito = lastIn.esito === esito;

      if (sameHand && sameMargine && sameMartingala && sameEsito) {
        // Aggiorna history comunque
        if (esito !== 'T') {
          rs.history.push(esito);
          while (rs.history.length > this.settings.windowW10) rs.history.shift();
        }
        this.enqueueTableOutcome(rs, esito.toLowerCase());
        
        const lastAdv = tableState.lastAdvice;
        lastAdv.signalW10 = this.isSevereRedTableSignal(rs) ? 'Red' : 'Green';
        
        await this.firestoreService.updateTableState(tableId, { rowState: rs });
        return lastAdv;
      }
    } else {
      await this.firestoreService.markInputSeen(tableId, handIndexMazzo);
    }

    // Warm-up inputs
    rs.warmInputs++;
    const inGrace = rs.warmInputs <= 3;
    let isInvalid = invalid;
    
    if (invalid && rs.forceToL8Active && martingalaUi >= 6) isInvalid = false;
    if (invalid && inGrace) isInvalid = false;

    if (isInvalid) {
      rs.invalidCount++;
      rs.validRecovery = 0;

      if (rs.invalidCount >= 5) {
        rs.disabled = true;
        await this.firestoreService.updateTableState(tableId, { rowState: rs });
        return {
          tableId,
          levelIndex: 0,
          stakeUnits: 0,
          globalMargin: 0,
          stopAtL5: true,
          authorizedHeavy: false,
          reason: 'Tavolo disabilitato',
          signalW10: 'Red',
          signalTableW10: 'Red',
          hotZone: false,
          tooltipJson: '',
          hotZoneLabel: '',
          portfolioDebtUnits: 0,
          hotOverridesActive: 0,
          hotOverridesUsedThisShoe: 0,
          vmLocal20: 0,
          prediction: 'Disabled',
          tableStatus: '🔴 Disabled'
        };
      }

      await this.firestoreService.updateTableState(tableId, { rowState: rs });
      return {
        tableId,
        levelIndex: 0,
        stakeUnits: 0,
        globalMargin: 0,
        stopAtL5: false,
        authorizedHeavy: false,
        reason: 'Input invalido',
        signalW10: 'Yellow',
        signalTableW10: 'Yellow',
        hotZone: false,
        tooltipJson: '',
        hotZoneLabel: '',
        portfolioDebtUnits: 0,
        hotOverridesActive: 0,
        hotOverridesUsedThisShoe: 0,
        vmLocal20: 0,
        prediction: 'Safe',
        tableStatus: '🟡 Warning'
      };
    }

    // Valid recovery
    rs.validRecovery++;
    if (rs.validRecovery >= 3) {
      rs.disabled = false;
      rs.invalidCount = 0;
    }

    // Update margin (transazione atomica per global margin)
    const k = Math.max(0.0000001, this.settings.k);
    const margineUnits = margineK / k;
    await this.firestoreService.incrementGlobalMargin(tableId, margineUnits);
    
    // Ricarica global state aggiornato
    const globalState = await this.firestoreService.getGlobalState();

    // Update regia parameters
    await this.regiaDynamic.updateDynamicParameters(
      globalState.globalMarginUnits,
      totalElapsedMinutes,
      totaltables
    );

    // Check mission stop
    if (await this.regiaDynamic.shouldStopMission()) {
      const stopAdvice: Advice = {
        tableId,
        levelIndex: 0,
        stakeUnits: 0,
        globalMargin: Math.round(globalState.globalMarginUnits * this.settings.k * 100) / 100,
        authorizedHeavy: false,
        stopAtL5: true,
        reason: 'STOP-WIN',
        signalW10: 'Green',
        signalTableW10: 'Green',
        hotZone: false,
        hotZoneLabel: this.getHotZoneLabel(handIndexMazzo),
        tooltipJson: '',
        portfolioDebtUnits: globalState.portfolioDebtUnits,
        hotOverridesActive: globalState.hotOverridesActive,
        hotOverridesUsedThisShoe: globalState.hotOverridesUsedThisShoe,
        vmLocal20: rs.vmLocal20,
        prediction: 'Stop Missione',
        tableStatus: '🟢 Mission Complete'
      };

      await this.saveAdviceAndInput(tableId, rs, stopAdvice, handIndexMazzo, margineK, martingalaUi, esito);
      return stopAdvice;
    }

    // Check preemptive L5 stop
    if (martingalaUi === 5) {
      const early = await this.checkPreemptiveStopL5(tableId);
      if (early) {
        early.reason = 'Stop L5 anticipato';
        early.hotZone = false;
        early.signalW10 = 'Green';
        early.hotZoneLabel = this.getHotZoneLabel(handIndexMazzo);
        early.prediction = 'Stop L5';
        
        await this.saveAdviceAndInput(tableId, rs, early, handIndexMazzo, margineK, martingalaUi, esito);
        return early;
      }
    }

    // Process outcome
    const levelIdx = OutcomeInferer.toLevelIndex(martingalaUi);
    const stakeUnitsNow = this.settings.levels[Math.min(levelIdx, this.settings.levels.length - 1)];
    const stakeShownK = stakeUnitsNow * this.settings.k;
    const outcome = esito;

    // Update history
    if (outcome !== 'T') {
      rs.history.push(outcome);
      while (rs.history.length > this.settings.windowW10) rs.history.shift();
    }
    this.enqueueTableOutcome(rs, outcome.toLowerCase());

    // Update RunP
    if (outcome === 'P') rs.runP++;
    else if (outcome === 'B') rs.runP = 0;

    // Update hand count and VM
    rs.handCount++;
    rs.margineAccum += margineK;
    if (rs.handCount % 20 === 0) {
      rs.vmLocal20 = rs.margineAccum / 20.0;
      rs.margineAccum = 0.0;
    }

    // Check exiting heavy
    const exitingHeavy = outcome === 'B' && rs.prevLevel >= 5 && levelIdx === 0;
    if (exitingHeavy && rs.forceToL8Active) {
      rs.forceToL8Active = false;
      const newHotOverrides = Math.max(0, globalState.hotOverridesActive - 1);
      await this.firestoreService.updateGlobalState({
        hotOverridesActive: newHotOverrides
      });
    }

    // Decrement cooldown
    if (globalState.cooldown > 0) {
      await this.firestoreService.updateGlobalState({
        cooldown: globalState.cooldown - 1
      });
    }

    const regia = this.getRegiaParams(globalState.globalMarginUnits);

    // Build advice
    const adv: Advice = {
      tableId,
      levelIndex: levelIdx,
      stakeUnits: Math.round(stakeShownK * 100) / 100,
      stopAtL5: false,
      authorizedHeavy: false,
      signalW10: 'Green',
      signalTableW10: 'Green',
      hotZone: this.inHotZone(handIndexMazzo, bHotZone),
      globalMargin: Math.round(globalState.globalMarginUnits * this.settings.k * 100) / 100,
      reason: 'Default',
      hotZoneLabel: this.getHotZoneLabel(handIndexMazzo),
      tooltipJson: '',
      portfolioDebtUnits: globalState.portfolioDebtUnits,
      hotOverridesActive: globalState.hotOverridesActive,
      hotOverridesUsedThisShoe: globalState.hotOverridesUsedThisShoe,
      vmLocal20: rs.vmLocal20,
      prediction: 'Safe',
      tableStatus: '🟢 Active'
    };

    const inHot = adv.hotZone;
    const severeRed = this.isSevereRedTableSignal(rs);
    const hmaxClosed = globalState.heavyCount >= regia.hmax;
    const roomCooldown = globalState.cooldown > 0;

    // Dogma L8 logic
    if (rs.forceToL8Active && levelIdx >= 4) {
      adv.authorizedHeavy = true;
      adv.stopAtL5 = false;
      adv.prediction = 'Dogma L8';
      adv.reason = `Dogma attivo L${levelIdx + 1}`;
    }

    // Heavy level (L6+) with Dogma active
    if (levelIdx >= 5 && rs.forceToL8Active) {
      await this.scuderia.applySyncDelay(this.settings);
      adv.authorizedHeavy = true;
      adv.reason = `Dogma L${levelIdx + 1}`;
      adv.prediction = 'Dogma L8';

      await this.firestoreService.updateGlobalState({
        heavyCount: globalState.heavyCount + 1,
        cooldown: Math.max(globalState.cooldown, regia.cdn)
      });

      await this.finalizeRow(rs, handIndexMazzo, levelIdx, margineUnits, stakeUnitsNow, tableId, adv);
      await this.scuderia.applyHeavyDecay(this.settings, adv.authorizedHeavy && adv.levelIndex >= 5);
      await this.saveAdviceAndInput(tableId, rs, adv, handIndexMazzo, margineK, martingalaUi, esito);
      return adv;
    }

    // L5 decision logic
    if (levelIdx === 4 && !rs.forceToL8Active) {
      const capResidua = await this.estimateResidualCapacityUnits();
      const triggerDebt = globalState.portfolioDebtUnits > this.settings.debtTriggerRatio * capResidua;
      const canOverride =
        globalState.hotOverridesActive < this.settings.maxHotOverridesConcurrent &&
        globalState.hotOverridesUsedThisShoe < this.settings.maxHotOverridesPerShoe;

      if (inHot || severeRed) {
        // Stop at L5: hot zone or red signal
        adv.stopAtL5 = true;
        adv.reason = 'Stop L5: hot/rosso';
        adv.prediction = 'Stop L5';
        
        await this.firestoreService.updateGlobalState({
          portfolioDebtUnits: globalState.portfolioDebtUnits + this.settings.l5LossUnits
        });
        rs.l5ClosedCount++;
        
      } else if (rs.vmLocal20 > 0 && !roomCooldown && !hmaxClosed) {
        // Extend to L6: positive VM20
        await this.scuderia.applySyncDelay(this.settings);
        adv.authorizedHeavy = true;
        adv.stopAtL5 = false;
        adv.reason = `Dogma esteso L5 Vm20 ${rs.vmLocal20.toFixed(2)}`;
        adv.prediction = 'L6 autorizzata';
        
        await this.firestoreService.updateGlobalState({
          heavyCount: globalState.heavyCount + 1,
          cooldown: regia.cdn
        });
        rs.forceToL8Active = true;
        
      } else if (triggerDebt && !roomCooldown && !hmaxClosed && canOverride && rs.runP < 5) {
        // HOT override
        await this.scuderia.applySyncDelay(this.settings);
        adv.authorizedHeavy = true;
        adv.stopAtL5 = false;
        adv.reason = 'Override HOT L5';
        adv.prediction = 'L6 autorizzata';
        
        await this.firestoreService.updateGlobalState({
          heavyCount: globalState.heavyCount + 1,
          cooldown: regia.cdn,
          hotOverridesActive: globalState.hotOverridesActive + 1,
          hotOverridesUsedThisShoe: globalState.hotOverridesUsedThisShoe + 1
        });
        rs.forceToL8Active = true;
        
      } else {
        // Default: stop at L5
        adv.stopAtL5 = true;
        adv.authorizedHeavy = false;
        adv.reason = 'Stop L5 default';
        adv.prediction = 'Stop L5';
        
        await this.firestoreService.updateGlobalState({
          portfolioDebtUnits: globalState.portfolioDebtUnits + this.settings.l5LossUnits
        });
        rs.l5ClosedCount++;
      }
    }

    // Build tooltip (se manca TooltipBuilder, lasciare vuoto)
    try {
      const rp = this.getRegiaParams(globalState.globalMarginUnits);
      // TODO: Implementare TooltipBuilder.BuildTooltipJson quando fornito
      adv.tooltipJson = JSON.stringify({
        handNo: handIndexMazzo,
        runP: rs.runP,
        maxRunP: this.getMaxRunP(rs),
        heavyCount: globalState.heavyCount,
        hmax: rp.hmax,
        cdn: rp.cdn,
        cooldown: globalState.cooldown
      });
    } catch (ex: any) {
      adv.tooltipJson = JSON.stringify({ error: ex.message });
    }

    await this.finalizeRow(rs, handIndexMazzo, levelIdx, margineUnits, stakeUnitsNow, tableId, adv);
    await this.scuderia.applyHeavyDecay(this.settings, adv.authorizedHeavy && adv.levelIndex >= 5);
    await this.saveAdviceAndInput(tableId, rs, adv, handIndexMazzo, margineK, martingalaUi, esito);
    
    return adv;
  }

  private async finalizeRow(
    rs: RowState,
    handIndexMazzo: number,
    levelIdx: number,
    margineUnits: number,
    stakeUnitsNow: number,
    tableId: number,
    adv: Advice
  ): Promise<void> {
    rs.prevMazzo = handIndexMazzo;
    rs.prevLevel = levelIdx;
    rs.prevMargine = margineUnits;
    rs.prevStake = stakeUnitsNow;
  }

  private async saveAdviceAndInput(
    tableId: number,
    rs: RowState,
    adv: Advice,
    handIndex: number,
    margineK: number,
    martingalaUi: number,
    esito: string
  ): Promise<void> {
    const lastInput: LastInput = {
      handIndex,
      margineK,
      martingalaUi,
      esito
    };

    await this.firestoreService.updateTableState(tableId, {
      rowState: rs,
      lastAdvice: adv,
      lastInput
    });
  }

  private enqueueTableOutcome(rs: RowState, side: string): void {
    if (side !== 'p' && side !== 'b' && side !== 't') return;
    
    rs.historyTable.push(side);
    while (rs.historyTable.length > this.settings.windowW10) {
      rs.historyTable.shift();
    }
  }

  private isSevereRedTableSignal(rs: RowState): boolean {
    if (!rs.historyTable || rs.historyTable.length === 0) return false;

    let cur = 0;
    let maxRun = 0;
    let last = '';

    for (let i = rs.historyTable.length - 1; i >= 0; i--) {
      const o = rs.historyTable[i];
      if (o === 't') continue;

      if (last === '' || o === last) {
        cur++;
        maxRun = Math.max(maxRun, cur);
      } else {
        cur = 1;
      }
      last = o;
    }

    return maxRun > this.settings.maxRunSideAllowedTable + 2;
  }
}
