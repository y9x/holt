// Chat tools: the catalogue the Tools menu shows, the schemas the model sees, and the one rule for which
// tools a chat turn may use.
//
// Names, groups and descriptions are VS Code's (the Configure Tools list): the label is the tool's reference
// name, the description is VS Code's own text. VS Code's copilot and core tool sources define the parameters.
// Only tools that work are listed. VS Code tools that need VS Code itself, notebooks, a language server,
// a browser automation runtime or a GitHub account are not in this list.
//
// Where each tool runs:
//   - server: runSubagent, fetch, and the DuckDuckGo MCP tools (search, fetch_content, expand_link)
//   - browser: every other tool, executed in the browser's Dusk workspace (pages/ai/workspace/tools.ts)
//
// Shared by the browser (the menu and the send payload) and the server (which tools to offer and run).

export type ChatToolIcon = 'agent' | 'edit' | 'execute' | 'read' | 'search' | 'todo' | 'vscode' | 'web' | 'mcp'

export interface ChatTool {
  /** Stored in settings and used to match a request. Built-in tools use their name; MCP tools are `server:name`. */
  id: string
  /** The name the model calls the tool by. Built-in tools use their VS Code name. */
  name: string
  /** What the menu shows, as VS Code shows it. */
  label: string
  /** VS Code's description, shown after the label. Empty when VS Code has none. */
  description: string
  /** JSON schema for the model. Built-in tools always have one. */
  schema?: Record<string, unknown>
}

export interface ChatToolGroup {
  id: string
  label: string
  description: string
  icon: ChatToolIcon
  /** A group with one tool that is the tool itself: one row, no expander. */
  leaf?: boolean
  tools: ChatTool[]
}

export interface McpServer {
  id: string
  label: string
  description: string
  tools: ChatTool[]
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
})

const str = (description: string) => ({ type: 'string', description })
const bool = (description: string) => ({ type: 'boolean', description })
const num = (description: string) => ({ type: 'number', description })

/** A built-in tool: its name is its id. */
const builtin = (name: string, label: string, description: string, schema: Record<string, unknown>): ChatTool => ({
  id: name,
  name,
  label,
  description,
  schema,
})

export const BUILTIN_GROUPS: ChatToolGroup[] = [
  {
    id: 'agent',
    label: 'agent',
    description: 'Delegate tasks to other agents',
    icon: 'agent',
    tools: [
      builtin(
        'runSubagent',
        'runSubagent',
        'Run a task within an isolated subagent context to enable efficient organization of tasks and context window management.',
        object({
          prompt: str('A detailed description of the task for the agent to perform'),
          description: str('A short (3-5 word) description of the task'),
        }, ['prompt', 'description']),
      ),
    ],
  },
  {
    id: 'edit',
    label: 'edit',
    description: 'Edit files in your workspace',
    icon: 'edit',
    tools: [
      builtin(
        'createDirectory',
        'createDirectory',
        'Create new directories in your workspace',
        object({ dirPath: str('The absolute path to the directory to create.') }, ['dirPath']),
      ),
      builtin(
        'createFile',
        'createFile',
        'Create new files',
        object({
          filePath: str('The absolute path to the file to create.'),
          content: str('The content to write to the file.'),
        }, ['filePath', 'content']),
      ),
    ],
  },
  {
    id: 'execute',
    label: 'execute',
    description: 'Execute code and applications on your machine',
    icon: 'execute',
    tools: [
      builtin(
        'runInTerminal',
        'runInTerminal',
        'Run commands in the terminal',
        object({
          command: str('The command to run in the terminal.'),
          explanation: str('A one-sentence description of what the command does. This will be shown to the user before the command is run.'),
          goal: str('A short description of the goal or purpose of the command (e.g., "Install dependencies", "Start development server").'),
          mode: { type: 'string', enum: ['sync', 'async'], description: 'sync waits for the command to finish and returns its output. async starts it and returns a terminal id to poll.' },
          timeout: num('Milliseconds to wait in sync mode before stopping the command (default 60000, at most 300000).'),
        }, ['command', 'explanation', 'goal', 'mode']),
      ),
      builtin(
        'getTerminalOutput',
        'getTerminalOutput',
        '',
        object({ id: str('The ID of the terminal to check (returned by runInTerminal in async mode).') }, ['id']),
      ),
      builtin(
        'killTerminal',
        'killTerminal',
        '',
        object({ id: str('The ID of the persistent terminal to kill (returned by runInTerminal in async mode).') }, ['id']),
      ),
    ],
  },
  {
    id: 'read',
    label: 'read',
    description: 'Read files in your workspace',
    icon: 'read',
    tools: [
      builtin(
        'readFile',
        'readFile',
        'Read the contents of a file',
        object({
          filePath: str('The absolute path of the file to read.'),
          startLine: num('The line number to start reading from, 1-based.'),
          endLine: num('The inclusive line number to end reading at, 1-based.'),
        }, ['filePath', 'startLine', 'endLine']),
      ),
      builtin(
        'listDirectory',
        'listDirectory',
        'List the contents of a directory',
        object({ path: str('The absolute path to the directory to list.') }, ['path']),
      ),
    ],
  },
  {
    id: 'search',
    label: 'search',
    description: 'Search files in your workspace',
    icon: 'search',
    tools: [
      builtin(
        'fileSearch',
        'fileSearch',
        'Find files by name using a glob pattern',
        object({
          query: str('Search for files with names or paths matching this glob pattern.'),
          maxResults: num('The maximum number of results to return. Do not use this unless necessary, it can slow things down.'),
        }, ['query']),
      ),
      builtin(
        'textSearch',
        'textSearch',
        'Search for text in files by regular expression',
        object({
          query: str('The pattern to search for in files in the workspace. Be sure to set the isRegexp property properly to declare whether it\'s a regex or plain text pattern. Is case-insensitive.'),
          isRegexp: bool('Whether the pattern is a regex.'),
          includePattern: str('Search files matching this glob pattern. Will be applied to the relative path of files within the workspace.'),
          maxResults: num('The maximum number of results to return. Do not use this unless necessary, it can slow things down.'),
          includeIgnoredFiles: bool('Whether to include files that are normally ignored: hidden files and folders, and node_modules.'),
        }, ['query', 'isRegexp']),
      ),
    ],
  },
  {
    id: 'todo',
    label: 'todo',
    description: 'Manage and track todo items for task planning',
    icon: 'todo',
    leaf: true,
    tools: [
      {
        id: 'manage_todo_list',
        name: 'manage_todo_list',
        label: 'todo',
        description: 'Manage and track todo items for task planning',
        schema: object({
          todoList: {
            type: 'array',
            description: 'Complete array of all todo items. Must include ALL items - both existing and new.',
            items: object({
              id: num('Unique identifier for the todo. Use sequential numbers starting from 1.'),
              title: str('Concise action-oriented todo label (3-7 words). Displayed in UI.'),
              status: { type: 'string', enum: ['not-started', 'in-progress', 'completed'], description: 'not-started: Not begun | in-progress: Currently working (max 1) | completed: Fully finished with no blockers' },
            }, ['id', 'title', 'status']),
          },
        }, ['todoList']),
      },
    ],
  },
  {
    id: 'vscode',
    label: 'vscode',
    description: 'Use VS Code features',
    icon: 'vscode',
    tools: [
      builtin(
        'memory',
        'memory',
        'Manage persistent memory across conversations',
        object({
          command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'], description: 'The operation to perform on the memory file system.' },
          path: str('The absolute path to the file or directory inside /memories/, e.g. "/memories/notes.md". Used by all commands except `rename`.'),
          file_text: str('Required for `create`. The content of the file to create.'),
          old_str: str('Required for `str_replace`. The exact string in the file to replace. Must appear exactly once.'),
          new_str: str('Required for `str_replace`. The new string to replace old_str with.'),
          insert_line: num('Required for `insert`. The 0-based line number to insert text at. 0 inserts before the first line.'),
          insert_text: str('Required for `insert`. The text to insert at the specified line.'),
          view_range: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'Optional for `view`. A two-element array [start_line, end_line] (1-indexed) to view a specific range of lines.' },
          old_path: str('Required for `rename`. The current path of the file or directory to rename.'),
          new_path: str('Required for `rename`. The new path for the file or directory.'),
        }, ['command']),
      ),
    ],
  },
  {
    id: 'web',
    label: 'web',
    description: 'Fetch information from the web',
    icon: 'web',
    tools: [
      builtin(
        'fetch',
        'fetch',
        'Fetch the main content from a web page. You should include the URL of the page you want to fetch.',
        object({
          urls: { type: 'array', items: { type: 'string' }, description: 'An array of URLs to fetch content from.' },
          query: str('The query to search for in the web page\'s content. This should be a clear and concise description of the content you want to find.'),
        }, ['urls', 'query']),
      ),
    ],
  },
]

/** The DuckDuckGo MCP server's tools, with its own names and descriptions. */
export const MCP_SERVERS: McpServer[] = [
  {
    id: 'ddg-search',
    label: 'ddg-search',
    description: '',
    tools: [
      {
        id: 'ddg-search:search',
        name: 'search',
        label: 'search',
        description: 'Search the web using DuckDuckGo. Returns a list of results with titles, URLs, and snippets.',
        schema: object({
          query: str('The search query string. Be specific for better results (e.g., \'Python asyncio tutorial\' rather than \'Python\').'),
          max_results: num('Maximum number of results to return, between 1 and 20 (default: 10).'),
          region: str('Optional region/language code to localize results. Examples: \'us-en\' (USA/English), \'uk-en\' (UK/English), \'de-de\' (Germany/German).'),
        }, ['query']),
      },
      {
        id: 'ddg-search:fetch_content',
        name: 'fetch_content',
        label: 'fetch_content',
        description: 'Fetch and extract the main text content from a webpage. Strips out navigation, headers, footers, scripts, and styles to return clean readable text.',
        schema: object({
          url: str('The full URL of the webpage to fetch (must start with http:// or https://), or a ref://<id> token exactly as shown in search results.'),
          start_index: num('Character offset to start reading from (default: 0). Use this to paginate through long content.'),
          max_length: num('Maximum number of characters to return (default: 8000).'),
        }, ['url']),
      },
      {
        id: 'ddg-search:expand_link',
        name: 'expand_link',
        label: 'expand_link',
        description: 'Expand a shortened ref://<id> link token from search results back into the full URL.',
        schema: object({
          token: str('A ref://<id> token exactly as it appeared in search results (the bare id is also accepted).'),
        }, ['token']),
      },
    ],
  },
]

/** The menu's note, VS Code's own wording. */
export const TOOLS_NOTE = 'The selected tools will be applied globally for all chat sessions that use the default agent.'

/** Every tool in the menu, in display order. */
export function allChatTools(): ChatTool[] {
  return [
    ...BUILTIN_GROUPS.flatMap((group) => group.tools),
    ...MCP_SERVERS.flatMap((server) => server.tools),
  ]
}

const TOOLS = allChatTools()
const KNOWN_IDS = new Set(TOOLS.map((tool) => tool.id))

/** Built-in tools that run in the browser's workspace. Everything else runs on the server. */
export const CLIENT_TOOL_IDS: ReadonlySet<string> = new Set(
  BUILTIN_GROUPS.flatMap((group) => group.tools.map((tool) => tool.id))
    .filter((id) => !['runSubagent', 'fetch'].includes(id)),
)

/** Built-in tools the server runs itself, without a round trip to the browser. */
export const SERVER_BUILTIN_IDS: ReadonlySet<string> = new Set(['runSubagent', 'fetch'])

/** A tool is on unless the user turned it off. */
export function toolOn(overrides: Readonly<Record<string, boolean>>, tool: ChatTool): boolean {
  return overrides[tool.id] !== false
}

/** The ids a chat turn may use. With no overrides, every tool is on. */
export function enabledToolIds(overrides: Readonly<Record<string, boolean>>): string[] {
  return TOOLS.filter((tool) => toolOn(overrides, tool)).map((tool) => tool.id)
}

/**
 * Whether a tool the model was offered (by its model-facing name) may be offered or run.
 * An undefined set means no selection was sent: every tool is on.
 */
export function toolSpecEnabled(enabled: ReadonlySet<string> | undefined, specName: string): boolean {
  const tool = TOOLS.find((candidate) => candidate.name === specName)
  if (!tool) return false
  return enabled ? enabled.has(tool.id) : true
}

/** The model-facing schemas for the tools in `ids` that the selection allows. */
export function builtinToolSpecs(enabled: ReadonlySet<string> | undefined, ids: ReadonlySet<string>): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return TOOLS
    .filter((tool) => ids.has(tool.id) && tool.schema && toolSpecEnabled(enabled, tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema as Record<string, unknown> }))
}

/** The model-facing schemas for every client tool the selection allows. */
export function clientToolSpecs(enabled: ReadonlySet<string> | undefined): ReturnType<typeof builtinToolSpecs> {
  return builtinToolSpecs(enabled, CLIENT_TOOL_IDS)
}

/** The DuckDuckGo MCP tools' schemas, for the MCP route and the internal tool loop. */
export function mcpToolSpecs(enabled: ReadonlySet<string> | undefined): ReturnType<typeof builtinToolSpecs> {
  const ids = new Set(MCP_SERVERS.flatMap((server) => server.tools.map((tool) => tool.id)))
  return builtinToolSpecs(enabled, ids)
}

/**
 * Keeps only known tool ids and their explicit on/off choices. Anything else is dropped.
 * Only an explicit on or off is stored: a tool with no entry is on.
 */
export function normaliseToolOverrides(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, on] of Object.entries(raw as Record<string, unknown>)) {
    if (KNOWN_IDS.has(id) && typeof on === 'boolean') out[id] = on
  }
  return out
}

/** The tool ids a request sent, or undefined when none were sent. Unknown ids are dropped. */
export function sanitiseToolIds(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((id): id is string => typeof id === 'string' && KNOWN_IDS.has(id)).slice(0, 64)
}
