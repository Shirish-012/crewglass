// Which open folder a hook event belongs to (several windows can watch different folders): the most specific
// folder that contains the event's working directory, else whichever watcher already knows the session.

export interface Routable { folder: string | null; contains(cwd: string): boolean; knowsSession(id: string): boolean }

export function pickWatcher<T extends Routable>(watchers: T[], cwd: string | undefined, sessionId: string | undefined): T | undefined {
  const byFolder = watchers.filter((w) => w.folder && cwd && w.contains(cwd)).sort((a, b) => b.folder!.length - a.folder!.length)[0];
  return byFolder ?? (sessionId ? watchers.find((w) => w.knowsSession(sessionId)) : undefined);
}
