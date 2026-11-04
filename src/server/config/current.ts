import { loadConfig } from './env.ts'

// Loading is a side effect (self-configured mode may create config.json), so only the code that
// runs the server imports this; the CLI sets its environment first and loads it lazily.
export const config = loadConfig()
