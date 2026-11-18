/** Called after a decision: hides `code` from the queue, shows `message`, and moves on (to `replacement` after an edit). */
export type OnDecided = (code: string, message: string, replacement?: string) => void;
