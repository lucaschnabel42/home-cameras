import { createContext, useContext } from "react";
import { DEFAULT_CONFIG, type AppConfig } from "../lib/appConfig";

/**
 * The install's settings (lib/appConfig.ts) for every component. App reads
 * /helper/config and provides the value; until the answer arrives, and when
 * the helper is down, the value is DEFAULT_CONFIG (no pet).
 */
export const AppConfigContext = createContext<AppConfig>(DEFAULT_CONFIG);

export const useAppConfig = () => useContext(AppConfigContext);

/** The pet of this home, or null. */
export const usePet = () => useAppConfig().pet;
