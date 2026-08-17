import { Badge } from '@/components/ui/badge'

interface DriverStatus {
  driver: string
  healthy: boolean
  error: string | null
}

/**
 * One store's status: a badge naming the driver, a sentence about what that
 * driver means for durability/sharing, and a reachability note when it isn't
 * healthy. Usage counters and target health both resolve to a Redis-or-memory
 * driver the same way, so they share this row rather than duplicating it.
 */
function DriverStatusRow({
  label,
  driver,
  healthy,
  error,
  redisCopy,
  memoryCopy,
  unhealthyConsequence,
}: DriverStatus & {
  label: string
  redisCopy: React.ReactNode
  memoryCopy: React.ReactNode
  /** What "not enforced" means for this store, e.g. "Limits are not
   *  enforced" or "Breakers are not tracked". */
  unhealthyConsequence: string
}) {
  return (
    <div className="max-w-xl space-y-2 border-t pt-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <Badge variant={healthy ? 'default' : error === null ? 'secondary' : 'destructive'}>
          {driver}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        {driver === 'redis' ? redisCopy : memoryCopy}
      </p>

      {healthy ? null : error === null ? (
        <p className="text-xs text-muted-foreground">
          Connecting… {unhealthyConsequence} until the connection is established.
        </p>
      ) : (
        <p className="text-xs text-destructive">
          Not reachable: {error}. {unhealthyConsequence} — requests are
          served rather than rejected while the store is down.
        </p>
      )}
    </div>
  )
}

export function UsageStatus({
  usage,
  health,
}: {
  usage: DriverStatus
  health: DriverStatus
}) {
  return (
    <>
      <DriverStatusRow
        label="Usage counters"
        {...usage}
        unhealthyConsequence="Limits are not enforced"
        redisCopy={(
          <>
            Counters live in Redis, so every gateway instance shares one limit.
            They reset if Redis is flushed or is running without persistence —
            a budget is only as durable as the store holding it.
          </>
        )}
        memoryCopy={(
          <>
            Counters live in this instance&apos;s memory. They reset when the
            gateway restarts, and each instance enforces limits on its own — two
            replicas allow twice the configured rate. Set{' '}
            <span className="font-mono">REDIS_URL</span> to share counters and
            survive restarts.
          </>
        )}
      />
      <DriverStatusRow
        label="Target health"
        {...health}
        unhealthyConsequence="Breakers are not tracked"
        redisCopy={(
          <>
            Breaker state lives in Redis, so every gateway instance agrees on
            which targets are currently open.
          </>
        )}
        memoryCopy={(
          <>
            Breaker state lives in this instance&apos;s memory. Each instance
            opens and closes breakers on its own — two replicas can disagree
            about whether a target is healthy. Set{' '}
            <span className="font-mono">REDIS_URL</span> to share breaker
            state across instances.
          </>
        )}
      />
    </>
  )
}
