import { Firestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  GlobalState,
  ScuderiaState,
  RegiaState,
  TableState,
  ProactiveSettings,
  RowState,
  DEFAULT_SETTINGS
} from './types';

export class FirestoreService {
  constructor(
    private db: Firestore,
    private engineId: string
  ) {}

  private get engineRef() {
    return this.db.collection('engines').doc(this.engineId);
  }

  // ============ Global State ============
  async getGlobalState(): Promise<GlobalState> {
    const doc = await this.engineRef.collection('globalState').doc('current').get();
    if (!doc.exists) {
      const initial: GlobalState = {
        globalMarginUnits: 0,
        heavyCount: 0,
        cooldown: 0,
        portfolioDebtUnits: 0,
        hotOverridesActive: 0,
        hotOverridesUsedThisShoe: 0,
        lastUpdate: Timestamp.now()
      };
      await this.engineRef.collection('globalState').doc('current').set(initial);
      return initial;
    }
    return doc.data() as GlobalState;
  }

  async updateGlobalState(updates: Partial<GlobalState>): Promise<void> {
    await this.engineRef.collection('globalState').doc('current').update({
      ...updates,
      lastUpdate: FieldValue.serverTimestamp()
    });
  }

  async incrementGlobalMargin(tableId: number, marginDelta: number): Promise<void> {
    await this.db.runTransaction(async (transaction) => {
      const globalRef = this.engineRef.collection('globalState').doc('current');
      const globalDoc = await transaction.get(globalRef);
      
      const tableMarginsRef = this.engineRef.collection('tableMarginsCache').doc(tableId.toString());
      const tableMarginDoc = await transaction.get(tableMarginsRef);
      
      const currentTableMargin = tableMarginDoc.exists ? (tableMarginDoc.data()?.marginUnits || 0) : 0;
      const newTableMargin = marginDelta;
      const globalDelta = newTableMargin - currentTableMargin;
      
      const currentGlobalMargin = globalDoc.exists ? (globalDoc.data()?.globalMarginUnits || 0) : 0;
      
      transaction.set(tableMarginsRef, { marginUnits: newTableMargin }, { merge: true });
      transaction.set(globalRef, {
        globalMarginUnits: currentGlobalMargin + globalDelta,
        lastUpdate: FieldValue.serverTimestamp()
      }, { merge: true });
    });
  }

  // ============ Scuderia State ============
  async getScuderiaState(): Promise<ScuderiaState> {
    const doc = await this.engineRef.collection('scuderiaState').doc('current').get();
    if (!doc.exists) {
      const initial: ScuderiaState = {
        handsSinceLastHeavy: 0,
        recentHeavyTimestamps: []
      };
      await this.engineRef.collection('scuderiaState').doc('current').set(initial);
      return initial;
    }
    return doc.data() as ScuderiaState;
  }

  async updateScuderiaState(updates: Partial<ScuderiaState>): Promise<void> {
    await this.engineRef.collection('scuderiaState').doc('current').update(updates);
  }

  // ============ Regia State ============
  async getRegiaState(): Promise<RegiaState> {
    const doc = await this.engineRef.collection('regiaState').doc('current').get();
    if (!doc.exists) {
      const initial: RegiaState = {
        targetUnitsTotal: 900,
        targetMinutesTotal: 480,
        targetTables: 10,
        targetUnitsPerTable: 90,
        missionCompleted: false,
        vmTargetGlobal: 0.0,
        settings: DEFAULT_SETTINGS
      };
      await this.engineRef.collection('regiaState').doc('current').set(initial);
      return initial;
    }
    return doc.data() as RegiaState;
  }

  async updateRegiaState(updates: Partial<RegiaState>): Promise<void> {
    await this.engineRef.collection('regiaState').doc('current').update(updates);
  }

  // ============ Table State (partizionato per tableId) ============
  async getTableState(tableId: number): Promise<TableState> {
    const doc = await this.engineRef.collection('tables').doc(tableId.toString()).get();
    if (!doc.exists) {
      const initial: TableState = {
        rowState: this.createEmptyRowState(),
        lastAdvice: null,
        lastInput: null,
        marginUnits: 0,
        lastUpdate: Timestamp.now()
      };
      await this.engineRef.collection('tables').doc(tableId.toString()).set(initial);
      return initial;
    }
    return doc.data() as TableState;
  }

  async updateTableState(tableId: number, updates: Partial<TableState>): Promise<void> {
    await this.engineRef.collection('tables').doc(tableId.toString()).update({
      ...updates,
      lastUpdate: FieldValue.serverTimestamp()
    });
  }

  private createEmptyRowState(): RowState {
    return {
      prevMazzo: null,
      prevLevel: 0,
      prevMargine: 0,
      prevStake: 0,
      prevSignalW10: '',
      prevHotZone: false,
      history: [],
      historyTable: [],
      runP: 0,
      forceToL8Active: false,
      l5ClosedCount: 0,
      handCount: 0,
      margineAccum: 0.0,
      vmLocal20: 0.0,
      warmInputs: 0,
      invalidCount: 0,
      validRecovery: 0,
      disabled: false
    };
  }

  // ============ Seen Inputs (duplicate detection) ============
  async isInputSeen(tableId: number, handIndex: number): Promise<boolean> {
    const doc = await this.engineRef
      .collection('tables')
      .doc(tableId.toString())
      .collection('seenInputs')
      .doc(handIndex.toString())
      .get();
    return doc.exists;
  }

  async markInputSeen(tableId: number, handIndex: number): Promise<void> {
    await this.engineRef
      .collection('tables')
      .doc(tableId.toString())
      .collection('seenInputs')
      .doc(handIndex.toString())
      .set({ timestamp: FieldValue.serverTimestamp() });
  }

  // ============ Settings ============
  async getSettings(): Promise<ProactiveSettings> {
    const doc = await this.engineRef.collection('settings').doc('config').get();
    if (!doc.exists) {
      await this.engineRef.collection('settings').doc('config').set(DEFAULT_SETTINGS);
      return DEFAULT_SETTINGS;
    }
    return doc.data() as ProactiveSettings;
  }

  async updateSettings(updates: Partial<ProactiveSettings>): Promise<void> {
    await this.engineRef.collection('settings').doc('config').update(updates);
  }
}
