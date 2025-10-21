import { Keypair, PublicKey } from "@solana/web3.js";

export type ProgramStub = {
  addCalls: Array<{ event: string; handler: (event: any) => void }>;
  removeCalls: number[];
  fetchCalls: PublicKey[];
  fetchImpl: (pda: PublicKey) => Promise<any>;
  listeners: Map<number, { event: string; handler: (event: any) => void }>;
  addEventListener: (
    event: string,
    handler: (event: any) => void,
  ) => number | Promise<number>;
  removeEventListener: (id: number) => Promise<void>;
  account: {
    game: {
      fetch(pda: PublicKey): Promise<any>;
    };
  };
  programId: PublicKey;
  [key: string]: any;
};

export type CreateProgramStubOptions = {
  asyncRegistration?: boolean;
  programId?: PublicKey;
  fetchImpl?: (pda: PublicKey) => Promise<any>;
  overrides?: Partial<ProgramStub>;
};

export function createProgramStub(options: CreateProgramStubOptions = {}): ProgramStub {
  const {
    asyncRegistration = false,
    programId = Keypair.generate().publicKey,
    fetchImpl,
    overrides,
  } = options;

  let nextId = 1;
  const listeners = new Map<number, { event: string; handler: (event: any) => void }>();
  const addCalls: Array<{ event: string; handler: (event: any) => void }> = [];
  const removeCalls: number[] = [];
  const fetchCalls: PublicKey[] = [];

  const baseFetchImpl =
    fetchImpl ??
    (async (_pda: PublicKey) => {
      return {};
    });

  const stub: ProgramStub = {
    listeners,
    addCalls,
    removeCalls,
    fetchCalls,
    async fetchImpl(pda: PublicKey) {
      fetchCalls.push(pda);
      return baseFetchImpl(pda);
    },
    addEventListener(event, handler) {
      const id = nextId++;
      addCalls.push({ event, handler });
      listeners.set(id, { event, handler });
      if (asyncRegistration) {
        return new Promise<number>((resolve) => {
          setTimeout(() => resolve(id), 0);
        });
      }
      return id;
    },
    async removeEventListener(id) {
      removeCalls.push(id);
      listeners.delete(id);
    },
    account: {
      game: {
        fetch(pda: PublicKey) {
          return stub.fetchImpl(pda);
        },
      },
    },
    programId,
  };

  if (overrides) {
    Object.assign(stub, overrides);
  }

  return stub;
}
