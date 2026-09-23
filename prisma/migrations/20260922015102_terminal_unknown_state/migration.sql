-- Terminal callback expiry does not prove that Copilot or Windows Terminal failed.
UPDATE "Run"
SET
		"status" = 'UNKNOWN',
		"errorMessage" = 'Terminal callback expired; the Terminal state is unknown'
WHERE "status" = 'FAILED'
	AND "trigger" IN ('TERMINAL_START', 'TERMINAL_RESUME')
	AND "errorMessage" = 'Terminal callback token expired';