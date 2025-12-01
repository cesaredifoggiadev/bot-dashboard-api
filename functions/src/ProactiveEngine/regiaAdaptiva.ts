import { ProactiveSettings, MissionSnapshot, ValutazioneRisultato, RegiaState } from './types';
import { FirestoreService } from './firestoreService';

export class RegiaAdaptiva {
  private readonly efficiencyFactor = 0.25;

  constructor(
    private firestoreService: FirestoreService,
    private settings: ProactiveSettings
  ) {}

  async initialize(targetMargin: number = 500, targetMinutes: number = 180): Promise<void> {
    const state: RegiaState = {
      targetUnitsTotal: targetMargin,
      targetMinutesTotal: targetMinutes,
      targetTables: 10,
      targetUnitsPerTable: Math.max(1, Math.floor(targetMargin / 10)),
      missionCompleted: false,
      vmTargetGlobal: 0.0,
      settings: this.settings
    };
    await this.firestoreService.updateRegiaState(state);
  }

  async setMissionParameters(
    targetUnits: number,
    totalMinutes: number,
    totalTables: number
  ): Promise<void> {
    const updates: Partial<RegiaState> = {
      targetUnitsTotal: Math.max(100, targetUnits),
      targetMinutesTotal: Math.max(60, totalMinutes),
      targetTables: Math.max(1, totalTables),
      targetUnitsPerTable: Math.round(Math.max(100, targetUnits) / Math.max(1, totalTables)),
      missionCompleted: false
    };
    await this.firestoreService.updateRegiaState(updates);
  }

  async getMissionInfo(): Promise<{
    unitsTarget: number;
    minutesTarget: number;
    tablesTarget: number;
    vmTarget: number;
  }> {
    const state = await this.firestoreService.getRegiaState();
    return {
      unitsTarget: state.targetUnitsTotal,
      minutesTarget: state.targetMinutesTotal,
      tablesTarget: state.targetTables,
      vmTarget: state.vmTargetGlobal
    };
  }

  async shouldStopMission(): Promise<boolean> {
    const state = await this.firestoreService.getRegiaState();
    return state.missionCompleted;
  }

  async updateDynamicParameters(
    currentMarginUnits: number,
    elapsedMinutes: number,
    tavoliAttivi: number
  ): Promise<void> {
    const state = await this.firestoreService.getRegiaState();
    const warmUpMinutes = 10.0;

    // Warm-up phase
    if (elapsedMinutes < warmUpMinutes) {
      await this.updateSettingsForPhase({
        lowThresh: -800,
        highThresh: 800,
        debtTriggerRatio: 0.60,
        hmaxLow: 2,
        hmaxMid: 2,
        hmaxHigh: 1,
        cooldownLow: 1,
        cooldownMid: 1,
        cooldownHigh: 1
      });
      
      const vmTarget = state.targetUnitsTotal / state.targetMinutesTotal;
      await this.firestoreService.updateRegiaState({ vmTargetGlobal: vmTarget });
      return;
    }

    const targetTotalAdj =
      (state.targetUnitsTotal * Math.max(1, tavoliAttivi)) /
      Math.max(1, state.targetTables) *
      this.efficiencyFactor;

    const missionMinutes =
      (state.targetMinutesTotal * Math.max(1, tavoliAttivi)) /
      Math.max(1, state.targetTables) *
      1.2;

    const vmTarget = targetTotalAdj / Math.max(1.0, missionMinutes);
    await this.firestoreService.updateRegiaState({ vmTargetGlobal: vmTarget });

    const vm = currentMarginUnits / Math.max(1.0, elapsedMinutes);
    const progress = targetTotalAdj <= 0 ? 0 : currentMarginUnits / targetTotalAdj;

    // Mission completed
    if (currentMarginUnits >= targetTotalAdj && !state.missionCompleted) {
      await this.firestoreService.updateRegiaState({ missionCompleted: true });
      await this.updateSettingsForPhase({
        lowThresh: 0,
        highThresh: 0,
        hmaxLow: 0,
        hmaxMid: 0,
        hmaxHigh: 0,
        cooldownLow: 9999,
        cooldownMid: 9999,
        cooldownHigh: 9999
      });
      return;
    }

    // Late mission phase (>50% progress, >30% time)
    if (progress >= 0.50 && elapsedMinutes >= missionMinutes * 0.30) {
      await this.updateSettingsForPhase({
        lowThresh: -800,
        highThresh: 600,
        debtTriggerRatio: 0.65,
        hmaxLow: Math.max(2, Math.floor(tavoliAttivi / 4)),
        hmaxMid: 1,
        hmaxHigh: 0,
        cooldownLow: 1,
        cooldownMid: 2,
        cooldownHigh: 2
      });
      return;
    }

    // Adjust based on VM performance
    if (vm < vmTarget) {
      // Behind target: aggressive
      await this.updateSettingsForPhase({
        lowThresh: -1000,
        debtTriggerRatio: 0.55,
        hmaxLow: Math.max(5, Math.floor(tavoliAttivi / 2) + 1),
        cooldownLow: 1
      });
    } else if (vm > vmTarget * 1.5) {
      // Ahead of target: protective
      await this.updateSettingsForPhase({
        highThresh: 1000,
        hmaxHigh: 1,
        cooldownHigh: 2,
        debtTriggerRatio: 0.70
      });
    } else {
      // On target: neutral
      await this.updateSettingsForPhase({
        lowThresh: -1000,
        highThresh: 800,
        debtTriggerRatio: 0.60,
        hmaxMid: Math.max(2, Math.floor(tavoliAttivi / 5)),
        cooldownMid: 1
      });
    }
  }

  private async updateSettingsForPhase(updates: Partial<ProactiveSettings>): Promise<void> {
    const currentSettings = await this.firestoreService.getSettings();
    await this.firestoreService.updateSettings({ ...currentSettings, ...updates });
    // Aggiorna anche settings locali
    Object.assign(this.settings, updates);
  }

  async getDashboardSnapshot(
    currentMarginUnits: number,
    elapsedMinutes: number,
    tavoliAttivi: number,
    k: number
  ): Promise<MissionSnapshot> {
    const state = await this.firestoreService.getRegiaState();

    const targetUnitsAdj =
      (state.targetUnitsTotal * Math.max(1, tavoliAttivi)) / Math.max(1, state.targetTables);
    const missionMinutesAdj =
      (state.targetMinutesTotal * Math.max(1, tavoliAttivi)) / Math.max(1, state.targetTables);
    const vmTargetUnits = targetUnitsAdj / Math.max(1.0, missionMinutesAdj);

    const warmUpMinutes = 10.0;
    const warmUpActive = elapsedMinutes < warmUpMinutes;

    const targetEuro = targetUnitsAdj * k;
    const vmTargetEuro = vmTargetUnits * k;

    let achievementPct = 0.0;
    if (targetEuro > 0) {
      achievementPct = ((currentMarginUnits * k) / targetEuro) * 100.0;
    }

    return {
      targetUnitsAdj,
      missionMinutesAdj,
      vmTargetUnits,
      targetEuro,
      vmTargetEuro,
      warmUpMinutes,
      warmUpActive,
      achievementPercent: Math.round(achievementPct * 100) / 100,
      k,
      tavoliAttivi: Math.max(1, tavoliAttivi),
      missionCompleted: state.missionCompleted
    };
  }

  buildValutazione(
    snap: MissionSnapshot,
    currentMarginEuro: number,
    elapsedMinutes: number
  ): ValutazioneRisultato {
    const vm = currentMarginEuro / Math.max(1.0, elapsedMinutes);

    if (snap.warmUpActive) {
      return {
        message: `Warm-Up (${Math.round(elapsedMinutes * 10) / 10} / ${snap.warmUpMinutes.toFixed(0)} min)`,
        vmValue: 0,
        color: 'gray'
      };
    }

    const ratio = vm / Math.max(0.000001, snap.vmTargetEuro);
    let msg: string;
    let col: string;

    if (ratio < 0.9) {
      msg = `Dogma – Vm ${vm.toFixed(2)} €/min (under)`;
      col = 'red';
    } else if (ratio > 1.1) {
      msg = `Protection – Vm ${vm.toFixed(2)} €/min (forward)`;
      col = 'yellow';
    } else {
      msg = `Neutral – Vm ${vm.toFixed(2)} €/min (aligned)`;
      col = 'green';
    }

    msg += ` | Tavoli=${snap.tavoliAttivi} | Target=${snap.targetEuro.toFixed(0)} | VmTarget=${snap.vmTargetEuro.toFixed(2)} | K=${snap.k.toFixed(2)}`;

    return { message: msg, vmValue: vm, color: col };
  }
}
