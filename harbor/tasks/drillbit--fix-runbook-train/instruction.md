Your working directory is `/app`. It contains `runbook.txt`, an operations
runbook holding a single `drillbit` command.

That command was written against an older CLI and no longer validates: one
of its flag names and one of its values are not accepted by the current
`drillbit` CLI. Edit `runbook.txt` in place so the command validates, while
still describing the same intent — provision cluster `relay-3` as an edge
node in the US-West region with 2 replicas.

Leave the surrounding runbook text alone, and do not execute the command.
