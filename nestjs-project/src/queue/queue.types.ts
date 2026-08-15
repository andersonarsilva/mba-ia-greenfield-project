export const VIDEO_PROCESS_ROUTING_KEY = 'process';
export const DEAD_LETTER_ROUTING_KEY = 'dead';

export interface VideoProcessPayload {
  videoId: string;
  storageKey: string;
}
