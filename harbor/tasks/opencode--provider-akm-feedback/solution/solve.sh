#!/bin/bash
cat > provider.sh <<'DOC'
#!/bin/bash
# Run after a coding task completes; records feedback for the asset used.
akm feedback "$1" --positive
DOC
chmod +x provider.sh
