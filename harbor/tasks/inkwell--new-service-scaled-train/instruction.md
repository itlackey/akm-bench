Your working directory is `/app`, and it is empty.

Create `service.yaml` in the working directory: a complete inkwell service
definition for a service named `report-renderer`, running image
`renderer:v4.2.1` and listening on port 6060.

The service must also be configured so that:

- it autoscales on request rate, between 2 and 12 instances, targeting 250
  requests per second per instance;
- sustained traffic is capped at 300 requests per second, with burst
  capacity up to 600.
