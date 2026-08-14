import { Badge } from '@/components/ui/badge'

export function UsageStatus({
  driver,
  healthy,
  error,
}: {
  driver: string
  healthy: boolean
  error: string | null
}) {
  return (
    <div className="max-w-xl space-y-2 border-t pt-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">Usage counters</span>
        <Badge variant={healthy ? 'default' : error === null ? 'secondary' : 'destructive'}>
          {driver}
        </Badge>
      </div>

      {driver === 'redis' ? (
        <p className="text-xs text-muted-foreground">
          Counters live in Redis, so every gateway instance shares one limit.
          They reset if Redis is flushed or is running without persistence —
          a budget is only as durable as the store holding it.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Counters live in this instance&apos;s memory. They reset when the
          gateway restarts, and each instance enforces limits on its own — two
          replicas allow twice the configured rate. Set{' '}
          <span className="font-mono">REDIS_URL</span> to share counters and
          survive restarts.
        </p>
      )}

      {healthy ? null : error === null ? (
        <p className="text-xs text-muted-foreground">
          Connecting… Limits are not enforced until the connection is
          established.
        </p>
      ) : (
        <p className="text-xs text-destructive">
          Not reachable: {error}. Limits are not being enforced — requests are
          served rather than rejected while the store is down.
        </p>
      )}
    </div>
  )
}
