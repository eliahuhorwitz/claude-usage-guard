import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's folder: where Claude Code installed it, or this checkout. */
export const pluginRoot = () => process.env.CLAUDE_PLUGIN_ROOT || dirname(dirname(fileURLToPath(import.meta.url)))

/** What the person types to continue past a stop. The leading "!" runs it in their shell, outside Claude. */
export const approveCommand = (root = pluginRoot()) => `! node "${join(root, 'src', 'approve.mjs')}"`
