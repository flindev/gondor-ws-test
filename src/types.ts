export interface Env {
  BEACON: DurableObjectNamespace;
  APP_ID: string;
  APP_KEY: string;
  APP_SECRET: string;
}

export interface AppConfig {
  id: string;
  key: string;
  secret: string;
}

export interface SocketAttachment {
  socketId: string;
  channels: string[];
  presenceUserIds: Record<string, string>;
}

export interface PusherFrame {
  event: string;
  data?: unknown;
  channel?: string;
}

export interface PresenceMember {
  user_id: string;
  user_info: unknown;
}
