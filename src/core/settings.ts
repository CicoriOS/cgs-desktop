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
  version: string;
  remote: boolean;
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
    setRemote(enabled: boolean): Promise<DeviceSettings>;
    setAutoUpdate(enabled: boolean): Promise<DeviceSettings>;
    checkUpdate(): Promise<{ version: string; available?: string }>;
    signOut(): Promise<void>;
  };
}
