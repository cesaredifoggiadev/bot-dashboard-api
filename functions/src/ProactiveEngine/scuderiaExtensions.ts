import { ProactiveSettings } from './types';
import { FirestoreService } from './firestoreService';
import { Timestamp } from 'firebase-admin/firestore';

export class ScuderiaExtensions {
  constructor(private firestoreService: FirestoreService) {}

  async applySyncDelay(settings: ProactiveSettings): Promise<void> {
    if (settings && settings.syncDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, settings.syncDelayMs));
    }
  }

  async applyHeavyDecay(
    settings: ProactiveSettings,
    enteredHeavy: boolean
  ): Promise<void> {
    const scuderiaState = await this.firestoreService.getScuderiaState();
    const globalState = await this.firestoreService.getGlobalState();

    if (enteredHeavy) {
      await this.firestoreService.updateScuderiaState({
        handsSinceLastHeavy: 0
      });
      return;
    }

    const newHandsSince = scuderiaState.handsSinceLastHeavy + 1;
    const threshold = settings?.heavyDecayAfterHands || 4;

    let newHeavyCount = globalState.heavyCount;
    let newCooldown = globalState.cooldown;
    let resetHands = false;

    if (newCooldown === 0 && newHeavyCount > 0 && newHandsSince >= threshold) {
      newHeavyCount--;
      resetHands = true;
    } else if (newHeavyCount === 0 && newCooldown > 0) {
      resetHands = true;
    }

    await this.firestoreService.updateScuderiaState({
      handsSinceLastHeavy: resetHands ? 0 : newHandsSince
    });

    await this.firestoreService.updateGlobalState({
      heavyCount: newHeavyCount,
      cooldown: newCooldown
    });
  }

  async allowHeavyGlobal(settings: ProactiveSettings): Promise<boolean> {
    if (!settings) return true;

    const scuderiaState = await this.firestoreService.getScuderiaState();
    const now = Timestamp.now();
    const cutoffSeconds = now.seconds - settings.globalHeavyCapWindow;

    // Filtra timestamp vecchi
    const recentTimestamps = scuderiaState.recentHeavyTimestamps.filter(
      ts => ts.seconds > cutoffSeconds
    );

    if (recentTimestamps.length >= settings.globalHeavyCap) {
      return false;
    }

    // Aggiungi nuovo timestamp
    recentTimestamps.push(now);
    await this.firestoreService.updateScuderiaState({
      recentHeavyTimestamps: recentTimestamps
    });

    return true;
  }
}
