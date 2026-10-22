# spend-quota

A Claude Code mod that shows your monthly spend against a quota, with a pace check for today.

```
$824/2,000 · day 15/21 · expected $1,429
```

The line is green below today's expected range, yellow inside it and red above it.

## Install

At the prompt of a terminal session:

```
/plugin install spend-quota --marketplace OfirTres/spend-quota
```

From a shell:

```
claude plugin install spend-quota --marketplace OfirTres/spend-quota
```

Answer `y` to add the marketplace, then pick a scope.

## Use

- `/spend` shows the full report above the prompt for 10 seconds. It runs immediately, even mid-turn.
- The short line above appears for 10 seconds every round hour.

The report shows the month's spend against the quota, the work day, today's expected range with a verdict, and your days off. When the usage endpoint is rate-limited, the last good reading is shown with `updated Xm ago`.

## Configure

| Option | Default | Meaning |
| --- | --- | --- |
| `monthlyQuota` | `2000` | Quota in USD, used when the account reports no monthly limit |
| `daysOff` | `Fri,Sat` | Comma-separated weekdays excluded from the pace estimate |

Expected spend is `quota / workdays × workday-number`.

## How it works

The mod reads `extra_usage` from `https://api.anthropic.com/api/oauth/usage` with your own Claude login. The engine attaches the credential; the mod never sees the token. That endpoint is undocumented and rate-limited, so it may change or stop working without notice.

## License

MIT
