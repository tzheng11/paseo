export interface NativeWatchInput {
  root: string;
  kind: "parcel" | "directory";
  ignored?: readonly string[];
}

export type WatchHostCommand =
  | { action: "watch"; id: number; input: NativeWatchInput }
  | { action: "close"; id: number };

export interface WatchHostError {
  message: string;
  code?: string;
}

export type WatchHostMessage =
  | { action: "ready"; id: number }
  | { action: "closed"; id: number }
  | { action: "error"; id: number; error: WatchHostError }
  | { action: "events"; id: number; events: Array<[string, string | null]> };
