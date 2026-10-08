import { createContext, useContext } from "react";

export interface SessionContextValue {
  cwd: string;
  openWorker: (workerId: string) => void;
}

export const SessionContext = createContext<SessionContextValue>({ cwd: "", openWorker: () => {} });
export const useSession = () => useContext(SessionContext);
