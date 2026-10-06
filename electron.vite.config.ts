import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The ops MCP relay a terminal CLI starts under ELECTRON_RUN_AS_NODE: its own
          // bundle, so it never loads electron or the app (see ops-mcp-config-pure.ts).
          'ops-relay': resolve('src/main/ops-relay-main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          // Main window + quick-launcher overlay + approval toast + status pill
          // auxiliary windows (see src/main/overlay.ts, toast.ts, pill.ts).
          index: resolve('src/renderer/index.html'),
          overlay: resolve('src/renderer/overlay.html'),
          toast: resolve('src/renderer/toast.html'),
          pill: resolve('src/renderer/pill.html'),
          // A chat popped out into its own window (src/main/chat-popout.ts).
          popout: resolve('src/renderer/popout.html')
        },
        output: {
          // The `index` entry's main chunk was ~1.7 MB before any splitting (measured
          // via a one-off rollup-plugin-visualizer pass, not kept — see NEXT_FIXES.md
          // item #6). Breakdown of what actually dominated it:
          //   - highlight.js (all bundled languages, via rehype-highlight): ~384 kB
          //   - the markdown parse/render stack (react-markdown, remark-gfm,
          //     micromark*, mdast*, hast*, unified, vfile, property-information,
          //     markdown-table, lowlight): ~450 kB combined
          //   - @xterm/xterm + addons: ~326 kB (already peeled off separately below —
          //     ChatTerminal, its sole consumer, is now React.lazy-loaded, see Chat.tsx)
          //   - the 8 secondary views (Planner/Usage/Agents/Rooms/Remote/Scheduled/
          //     Mcp/Projects + SprintBoard): ~265 kB combined, but each only needed once
          //     the user navigates there — also moved to React.lazy, see App.tsx.
          // Lazy-loading the views and ChatTerminal already lets Rollup split them into
          // their own on-demand chunks automatically. What's left eagerly bundled into
          // `index` is the markdown/highlighting stack, because it's used by every chat
          // message (MessageBubble → Markdown) and so is needed on first paint — it
          // can't be deferred the same way. Pulling it into its own named chunk here
          // doesn't reduce total bytes shipped, but keeps the entry chunk itself under
          // the 500 kB warning threshold and gives the browser/Electron a stable,
          // separately-cacheable vendor file.
          //
          // This only affects the `index` entry: overlay/toast/pill never import
          // Markdown or highlight.js, so `manualChunks` (keyed off module id) simply
          // never assigns any of their modules to this chunk for those builds.
          manualChunks(id) {
            if (
              /node_modules[\\/](react-markdown|remark-gfm|rehype-highlight|highlight\.js|lowlight|micromark|mdast-util-|hast-util-|unist-util-|unified|vfile|property-information|markdown-table|space-separated-tokens|comma-separated-tokens|zwitch|longest-streak|ccount|escape-string-regexp|trim-lines|bail|is-plain-obj|trough|devlop)/.test(
                id
              )
            ) {
              return 'markdown'
            }
            return undefined
          }
        }
      }
    }
  }
})
