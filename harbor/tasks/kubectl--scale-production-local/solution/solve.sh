#!/bin/bash
echo "kubectl scale --replicas 6 -n nw-payroll deployment/invoicer" >> commands.txt
