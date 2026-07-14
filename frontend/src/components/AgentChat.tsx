import { useEffect, useRef, useState } from 'react'
import { Send, Plus, Trash2, Loader2, MessageCircle, Bot } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import * as api from '../api'
import type { AgentConversation, AgentMessage } from '../types'

interface Props {
  scenarioId: string
}

const SUGGESTIONS = [
  'Run the scheduler and summarize the result.',
  'Why are some units unshippable?',
  'What is the cheapest way to clear the shortfall?',
  'Which factory is the bottleneck?',
]

export function AgentChat({ scenarioId }: Props) {
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamBuffer, setStreamBuffer] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const optimisticMessageIdRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // Load conversation list when the scenario changes.
  useEffect(() => {
    setActiveConvId(null)
    setMessages([])
    setStreamBuffer('')
    setError(null)
    void api
      .listConversations(scenarioId)
      .then(setConversations)
      .catch((e) => setError(e.message ?? 'failed to load conversations'))
    return () => abortRef.current?.abort()
  }, [scenarioId])

  // Load messages when the active conversation changes.
  useEffect(() => {
    if (!activeConvId) {
      setMessages([])
      return
    }
    setLoadingHistory(true)
    api
      .getConversationMessages(activeConvId)
      .then(setMessages)
      .catch((e) => setError(e.message ?? 'failed to load messages'))
      .finally(() => setLoadingHistory(false))
  }, [activeConvId])

  // Auto-scroll to the bottom on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, streamBuffer, streaming])

  function startNewConversation() {
    abortRef.current?.abort()
    setActiveConvId(null)
    setMessages([])
    setStreamBuffer('')
    setError(null)
  }

  async function handleDelete(convId: string) {
    try {
      await api.deleteConversation(convId)
      setConversations((cs) => cs.filter((c) => c.id !== convId))
      if (convId === activeConvId) startNewConversation()
    } catch (e: unknown) {
      setError((e as { message?: string }).message ?? 'failed to delete conversation')
    }
  }

  function send(text: string) {
    const message = text.trim()
    if (!message || streaming) return
    setError(null)
    setInput('')

    // Optimistically show the user's message.
    const optimistic: AgentMessage = {
      id: `tmp-${++optimisticMessageIdRef.current}`,
      conversation_id: activeConvId ?? '',
      role: 'user',
      content: message,
      created_at: new Date().toISOString(),
    }
    setMessages((m) => [...m, optimistic])
    setStreaming(true)
    setStreamBuffer('')

    let buf = ''
    let newConvId: string | null = null

    abortRef.current = api.sendAgentMessage(
      { scenarioId, message, conversationId: activeConvId },
      {
        onConversation: (id) => {
          newConvId = id
          if (!activeConvId) setActiveConvId(id)
        },
        onChunk: (line) => {
          buf = buf ? `${buf}\n${line}` : line
          setStreamBuffer(buf)
        },
        onError: (msg) => {
          setError(msg)
          setStreaming(false)
          setStreamBuffer('')
          void refreshAfterTurn(newConvId)
        },
        onDone: () => {
          setStreaming(false)
          setStreamBuffer('')
          void refreshAfterTurn(newConvId)
        },
      },
    )
  }

  // After a turn, reload the persisted messages + conversation list (titles/order).
  async function refreshAfterTurn(newConvId: string | null) {
    const convId = activeConvId ?? newConvId
    try {
      const list = await api.listConversations(scenarioId)
      setConversations(list)
      if (convId) {
        const msgs = await api.getConversationMessages(convId)
        setMessages(msgs)
      }
    } catch {
      /* non-fatal: keep optimistic state */
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-220px)] min-h-[420px] rounded-lg border border-slate-200 bg-white overflow-hidden">
      {/* Conversation bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 bg-slate-50">
        <MessageCircle className="w-4 h-4 text-indigo-600 shrink-0" />
        <select
          className="flex-1 text-sm bg-white border border-slate-300 rounded px-2 py-1 min-w-0"
          value={activeConvId ?? ''}
          onChange={(e) => setActiveConvId(e.target.value || null)}
        >
          <option value="">New conversation</option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title ?? 'Untitled'}
            </option>
          ))}
        </select>
        <button
          onClick={startNewConversation}
          className="inline-flex items-center gap-1 px-2 py-1 text-sm border border-slate-300 bg-white rounded hover:bg-slate-100"
          title="New conversation"
        >
          <Plus className="w-4 h-4" />
        </button>
        {activeConvId && (
          <button
            onClick={() => handleDelete(activeConvId)}
            className="inline-flex items-center gap-1 px-2 py-1 text-sm border border-slate-300 bg-white rounded hover:bg-rose-50 text-rose-600"
            title="Delete conversation"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 bg-slate-50">
        {loadingHistory ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : messages.length === 0 && !streaming ? (
          <EmptyState onPick={send} disabled={streaming} />
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} />
            ))}
            {streaming && (
              <div className="flex justify-start mb-3">
                <div className="max-w-[85%] rounded-lg px-4 py-3 text-sm bg-white border border-slate-200 text-slate-800">
                  <div className="flex items-center gap-2 mb-1 text-xs text-slate-400">
                    <Bot className="w-3.5 h-3.5" /> Agent
                  </div>
                  {streamBuffer ? (
                    <div className="prose-chat">
                      <ReactMarkdown>{streamBuffer}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-slate-500">
                      <Loader2 className="w-4 h-4 animate-spin" /> Thinking…
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="px-4 py-2 text-sm text-rose-700 bg-rose-50 border-t border-rose-200">
          {error}
        </div>
      )}

      {/* Input */}
      <form
        className="flex items-end gap-2 p-3 border-t border-slate-200 bg-white"
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
      >
        <textarea
          className="flex-1 resize-none text-sm border border-slate-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-200 max-h-32"
          rows={1}
          placeholder="Ask the scheduling expert…"
          value={input}
          disabled={streaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(input)
            }
          }}
        />
        <button
          type="submit"
          disabled={streaming || !input.trim()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {streaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          Send
        </button>
      </form>
    </div>
  )
}

function EmptyState({ onPick, disabled }: { onPick: (t: string) => void; disabled: boolean }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center text-slate-500">
      <Bot className="w-10 h-10 text-indigo-300 mb-3" />
      <div className="font-medium text-slate-600">Ask the scheduling expert</div>
      <div className="text-sm mt-1 max-w-md">
        Powered by Devin. It can read this scenario, run the scheduler, and test what-if
        changes to answer your questions.
      </div>
      <div className="flex flex-wrap justify-center gap-2 mt-4 max-w-lg">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            disabled={disabled}
            onClick={() => onPick(s)}
            className="text-xs px-3 py-1.5 border border-slate-300 bg-white rounded-full hover:bg-indigo-50 hover:border-indigo-300 text-slate-600 disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

function MessageBubble({ msg }: { msg: AgentMessage }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 text-sm ${
          isUser
            ? 'bg-indigo-600 text-white'
            : 'bg-white border border-slate-200 text-slate-800'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{msg.content}</p>
        ) : (
          <>
            <div className="flex items-center gap-2 mb-1 text-xs text-slate-400">
              <Bot className="w-3.5 h-3.5" /> Agent
            </div>
            <div className="prose-chat">
              <ReactMarkdown>{msg.content}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
