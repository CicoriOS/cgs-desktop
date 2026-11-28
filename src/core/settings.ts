import type { ThinkingLevel } from "./types";

export interface UsageEntry {
  at: number;
  model: string;
  project: string;
  input: number;
  cacheRead: number;
  output: number;
  cost: number;
  cacheSavings: number;
}

export interface UsageReport {
  currency: string;
  entries: UsageEntry[];
}

export interface ModelOption {
  id: string;
  label: string;
  thinking: ThinkingLevel[];
}

export interface RoleModel {
  model: string;
  thinking: ThinkingLevel | "auto" | "";
}

export interface AgentRole extends RoleModel {
  name: string;
  builtIn?: boolean;
}

export interface Orchestration {
  main: RoleModel;
  agents: AgentRole[];
  /** Empty leaves network search to omp's own strategy. Otherwise this is the modelRoles.web selector. */
  web: string;
}

export interface DeviceSettings {
  /** The core: the cgscli the conversations run in (ADR 0048). */
  version: string;
  /** The experience package, `N.M`: the desktop app itself. Absent where there is no desktop app (the web client). */
  packageVersion?: string;
  remote: boolean;
  /** A remote-access password exists; the first time on asks for one. */
  hasPassword: boolean;
  /** This device's mark for pairing: the emoji of its key and their names in the page's language. */
  fingerprint?: { emoji: string[]; zh: string[]; en: string[] };
  autoUpdate: boolean;
}

export interface SettingsApi {
  /** The development host stores changes in memory and never controls a real device. */
  preview?: true;
  /** Rates are for the local usage report, not the account ledger. */
  usage(): Promise<UsageReport>;
  agents: {
    read(): Promise<{ models: ModelOption[]; layout: Orchestration; defaults: Orchestration }>;
    save(layout: Orchestration): Promise<Orchestration>;
  };
  device: {
    read(): Promise<DeviceSettings>;
    /** `password` is the first one, sent only when the device has none yet (rejects `password_required` without it). */
    setRemote(enabled: boolean, password?: string): Promise<DeviceSettings>;
    /** Rejects `password_too_short`; every authorized browser has to sign in again afterwards. */
    setPassword(password: string): Promise<DeviceSettings>;
    setAutoUpdate(enabled: boolean): Promise<DeviceSettings>;
    checkUpdate(): Promise<{ version: string; available?: string }>;
    signOut(): Promise<void>;
  };
}
