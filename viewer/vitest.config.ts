import { defineConfig } from 'vitest/config'

// The tests run in Node, without vite.config.ts and its Cloudflare plugin, which starts a
// Workers runtime of its own; test/worker.test.ts gets the Worker's bindings from Wrangler.
export default defineConfig({})
