-- Índice redundante: (resolution, ts) ya cubre todo lo que filtraba por ts, y
-- éste llegó a pesar más de 1 GB en producción. DROP sin CONCURRENTLY porque el
-- migrador corre en transacción; borrar un índice es instantáneo.
DROP INDEX IF EXISTS "container_samples_ts_idx";
