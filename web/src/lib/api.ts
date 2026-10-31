import type { CreateRoomRequest, CreateRoomResponse, ProviderStatus, SttTokenResponse } from '../../../shared/contracts'
import type { TopicsResponse } from '../../../shared/topic'

export type SavedRoom = CreateRoomResponse & { resumed: boolean }
export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, signal: options.signal ?? AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/json', ...options.headers } })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const error = body && typeof body === 'object' && 'error' in body ? body.error : null
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : `The room could not connect (${response.status}).`
    throw new Error(message)
  }
  return body as T
}
export const getStatus = () => request<ProviderStatus>('/api/status')
export const getTopics = () => request<TopicsResponse>('/api/topics')
export const createRoom = (input: CreateRoomRequest) => request<CreateRoomResponse>('/api/rooms', { method: 'POST', body: JSON.stringify(input) })
export const getScribeToken = (room: SavedRoom, signal?: AbortSignal) => request<SttTokenResponse>(`/api/rooms/${encodeURIComponent(room.roomId)}/stt-token`, { method: 'POST', headers: { 'x-room-token': room.roomToken }, signal })
const storageKey = 'apprentice.local-room.v1'
export function readSavedRoom(): SavedRoom | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (value && typeof value === 'object' && 'roomId' in value && 'roomToken' in value && 'sessionId' in value && typeof value.roomId === 'string' && typeof value.roomToken === 'string' && typeof value.sessionId === 'string') return { roomId: value.roomId, roomToken: value.roomToken, sessionId: value.sessionId, resumed: true }
  } catch { /* A corrupt saved session must not prevent a new session. */ }
  return null
}
export function saveRoom(room: CreateRoomResponse): void { localStorage.setItem(storageKey, JSON.stringify(room)) }
export function forgetRoom(): void { localStorage.removeItem(storageKey) }
