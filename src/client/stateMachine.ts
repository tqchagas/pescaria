import { FishingState } from '../shared/types.js';

export type FishingTrigger =
  | 'START_CAST'
  | 'BOBBER_LANDED'
  | 'FISH_HOOKED'
  | 'SHOW_REWARD_MODAL'
  | 'FISH_RESOLVED'
  | 'RESET';

export type StateChangeHandler = (
  from: FishingState,
  to: FishingState,
  payload?: any
) => void;

/**
 * Máquina de Estados Finita (FSM) para o Ciclo de Pesca 2D
 * Estados: IDLE -> CASTING -> REELING -> CAUGHT -> INVENTORY_ACTION -> IDLE
 */
export class FishingStateMachine {
  private currentState: FishingState = 'IDLE';
  private listeners: StateChangeHandler[] = [];

  // Tabela de transições válidas
  private readonly transitions: Record<FishingState, Partial<Record<FishingTrigger, FishingState>>> = {
    IDLE: {
      START_CAST: 'CASTING',
      RESET: 'IDLE',
    },
    CASTING: {
      BOBBER_LANDED: 'REELING',
      RESET: 'IDLE',
    },
    REELING: {
      FISH_HOOKED: 'CAUGHT',
      RESET: 'IDLE',
    },
    CAUGHT: {
      SHOW_REWARD_MODAL: 'INVENTORY_ACTION',
      RESET: 'IDLE',
    },
    INVENTORY_ACTION: {
      FISH_RESOLVED: 'IDLE',
      RESET: 'IDLE',
    },
  };

  constructor(initialState: FishingState = 'IDLE') {
    this.currentState = initialState;
  }

  public getState(): FishingState {
    return this.currentState;
  }

  public is(state: FishingState): boolean {
    return this.currentState === state;
  }

  public can(trigger: FishingTrigger): boolean {
    const available = this.transitions[this.currentState];
    return !!(available && available[trigger]);
  }

  public transition(trigger: FishingTrigger, payload?: any): boolean {
    const available = this.transitions[this.currentState];
    const nextState = available ? available[trigger] : undefined;

    if (!nextState) {
      console.warn(`[FishingStateMachine] Transição inválida: "${trigger}" a partir do estado "${this.currentState}"`);
      return false;
    }

    const previousState = this.currentState;
    this.currentState = nextState;

    this.notify(previousState, nextState, payload);
    return true;
  }

  public subscribe(handler: StateChangeHandler): () => void {
    this.listeners.push(handler);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== handler);
    };
  }

  private notify(from: FishingState, to: FishingState, payload?: any) {
    for (const handler of this.listeners) {
      try {
        handler(from, to, payload);
      } catch (err) {
        console.error('[FishingStateMachine] Erro no listener:', err);
      }
    }
  }
}
