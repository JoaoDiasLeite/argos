import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile } from './json-file'

// A weekly plan is keyed by its Monday (ISO date, e.g. "2026-06-15") and stored
// as one JSON file per week.

export type Effort = 'light' | 'medium' | 'deep'

export interface WeeklyPriority {
  id: string
  title: string
  color: string
}

export interface PlannerTask {
  id: string
  title: string
  /** 0 = Monday … 6 = Sunday, or null for the unscheduled backlog. */
  day: number | null
  done: boolean
  priorityId?: string | null
  /** Start time, "HH:MM". */
  timeOfDay?: string | null
  /** End time, "HH:MM". */
  endTime?: string | null
  durationMin?: number | null
  effort?: Effort | null
  notes?: string | null
}

export interface SavedReview {
  id: string
  createdAt: number
  mode: 'review' | 'reflect'
  model?: string
  score?: number | null
  summary?: string
  warnings?: string[]
  suggestions?: { title: string; detail?: string }[]
  wins?: string[]
  misses?: string[]
  adjustments?: string[]
}

export interface WeekPlan {
  /** Monday of the week, ISO date "YYYY-MM-DD". Doubles as the storage key. */
  weekStart: string
  intention?: string
  priorities: WeeklyPriority[]
  tasks: PlannerTask[]
  reflection?: string
  reviews?: SavedReview[]
  createdAt: number
  updatedAt: number
}

const plannerDir = path.join(app.getPath('userData'), 'planner')

function ensurePlannerDir(): void {
  if (!fs.existsSync(plannerDir)) fs.mkdirSync(plannerDir, { recursive: true })
}

function fileFor(weekStart: string): string {
  // weekStart is validated by the renderer (always YYYY-MM-DD), but guard anyway.
  const safe = weekStart.replace(/[^0-9-]/g, '')
  return path.join(plannerDir, `${safe}.json`)
}

function emptyWeek(weekStart: string): WeekPlan {
  const now = Date.now()
  return {
    weekStart,
    intention: '',
    priorities: [],
    tasks: [],
    reflection: '',
    createdAt: now,
    updatedAt: now
  }
}

/** List the week-start keys that have a saved plan, most recent first. */
export function listWeeks(): string[] {
  ensurePlannerDir()
  try {
    return fs
      .readdirSync(plannerDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort((a, b) => b.localeCompare(a))
  } catch {
    return []
  }
}

/** Load a week's plan, or a fresh empty plan if none exists yet. */
export function getWeek(weekStart: string): WeekPlan {
  const p = fileFor(weekStart)
  if (!fs.existsSync(p)) return emptyWeek(weekStart)
  try {
    const parsed = readJsonFile<WeekPlan>(p)
    return { ...emptyWeek(weekStart), ...parsed, weekStart }
  } catch {
    return emptyWeek(weekStart)
  }
}

export function saveWeek(week: WeekPlan): WeekPlan {
  ensurePlannerDir()
  const next: WeekPlan = { ...week, updatedAt: Date.now() }
  fs.writeFileSync(fileFor(week.weekStart), JSON.stringify(next, null, 2))
  return next
}

export function deleteWeek(weekStart: string): string[] {
  const p = fileFor(weekStart)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  return listWeeks()
}
