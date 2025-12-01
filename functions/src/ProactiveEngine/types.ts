import { Timestamp } from 'firebase-admin/firestore';

export enum Signal {
  Green = 'Green',
  YellowOrRed = 'YellowOrRed'
}

export interface ProactiveSettings {
  levels: number[];
  k: number;
  windowW10: number;
  maxRunPAllowed: number;
  maxRunSideAllowedTable: number;
  hotZones: Array<{ start: number; end: number }>;
  highThresh: number;
  lowThresh: number;
  hmaxHigh: number;
  hmaxMid: number;
  hmaxLow: number;
  cooldownHigh: number;
  cooldownMid: number;
  cooldownLow: number;
  l5LossUnits: number;
  maxHotOverridesConcurrent: number;
  maxHotOverridesPerShoe: number;
  debtTriggerRatio: number;
  meanUnitsPerHandPerTable: number;
  estimatedHandsLeftPerTable: number;
  syncDelayMs: number;
  heavyDecayAfterHands: number;
  resetOnMapChange: boolean;
  globalHeavyCapWindow: number;
  globalHeavyCap: number;
  perTableHeavyLimit: number;
}

export const DEFAULT_SETTINGS: ProactiveSettings = {
  levels: [1, 3, 7, 15, 35, 75, 155, 340],
  k: 1.0,
  windowW10: 20,
  maxRunPAllowed: 2,
  maxRunSideAllowedTable: 3,
  hotZones: [
    { start: 11, end: 20 },
    { start: 41, end: 50 },
    { start: 51, end: 60 },
    { start: 61, end: 70 }
  ],
  highThresh: 250,
  lowThresh: -300,
  hmaxHigh: 1,
  hmaxMid: 1,
  hmaxLow: 1,
  cooldownHigh: 4,
  cooldownMid: 3,
  cooldownLow: 2,
  l5LossUnits: 61,
  maxHotOverridesConcurrent: 0,
  maxHotOverridesPerShoe: 1,
  debtTriggerRatio: 0.60,
  meanUnitsPerHandPerTable: 0.50,
  estimatedHandsLeftPerTable: 35,
  syncDelayMs: 120,
  heavyDecayAfterHands: 5,
  resetOnMapChange: true,
  globalHeavyCapWindow: 60,
  globalHeavyCap: 4,
  perTableHeavyLimit: 2
};

export interface Advice {
  tableId: number;
  levelIndex: number;
  stakeUnits: number;
  globalMargin: number;
  stopAtL5: boolean;
  authorizedHeavy: boolean;
  reason: string;
  signalW10: string;
  signalTableW10: string;
  hotZone: boolean;
  tooltipJson: string;
  hotZoneLabel: string;
  portfolioDebtUnits: number;
  hotOverridesActive: number;
  hotOverridesUsedThisShoe: number;
  vmLocal20: number;
  prediction: string;
  tableStatus: string;
}

export interface RowState {
  prevMazzo: number | null;
  prevLevel: number;
  prevMargine: number;
  prevStake: number;
  prevSignalW10: string;
  prevHotZone: boolean;
  history: string[];  // Array instead of Queue
  historyTable: string[];
  runP: number;
  forceToL8Active: boolean;
  l5ClosedCount: number;
  handCount: number;
  margineAccum: number;
  vmLocal20: number;
  warmInputs: number;
  invalidCount: number;
  validRecovery: number;
  disabled: boolean;
}

export interface LastInput {
  handIndex: number;
  margineK: number;
  martingalaUi: number;
  esito: string;
}

export interface GlobalState {
  globalMarginUnits: number;
  heavyCount: number;
  cooldown: number;
  portfolioDebtUnits: number;
  hotOverridesActive: number;
  hotOverridesUsedThisShoe: number;
  lastUpdate: Timestamp;
}

export interface ScuderiaState {
  handsSinceLastHeavy: number;
  recentHeavyTimestamps: Timestamp[];
}

export interface RegiaState {
  targetUnitsTotal: number;
  targetMinutesTotal: number;
  targetTables: number;
  targetUnitsPerTable: number;
  missionCompleted: boolean;
  vmTargetGlobal: number;
  settings: ProactiveSettings;
}

export interface TableState {
  rowState: RowState;
  lastAdvice: Advice | null;
  lastInput: LastInput | null;
  marginUnits: number;
  lastUpdate: Timestamp;
}

export interface MissionSnapshot {
  targetUnitsAdj: number;
  missionMinutesAdj: number;
  vmTargetUnits: number;
  targetEuro: number;
  vmTargetEuro: number;
  warmUpMinutes: number;
  warmUpActive: boolean;
  achievementPercent: number;
  k: number;
  tavoliAttivi: number;
  missionCompleted: boolean;
}

export interface ValutazioneRisultato {
  message: string;
  vmValue: number;
  color: string;
}
