/* ============================================================================
 * Fixtures de /proc.
 *
 * Capturados de un host Linux real (Debian 12, kernel 6.1, 4 núcleos). Se
 * guardan como texto y no como objetos ya parseados para que los tests
 * ejerciten el parser completo, incluidos los detalles que rompen las
 * implementaciones ingenuas: nombres de proceso con espacios y paréntesis,
 * columnas faltantes en kernels viejos, rutas con espacios escapados en octal.
 * ========================================================================== */

export const STAT = `cpu  1234567 8901 234567 45678901 12345 0 6789 1011 0 0
cpu0 308641 2225 58641 11419725 3086 0 1697 252 0 0
cpu1 308642 2226 58642 11419726 3087 0 1698 253 0 0
cpu2 308641 2225 58641 11419725 3086 0 1697 253 0 0
cpu3 308643 2225 58643 11419725 3086 0 1697 253 0 0
intr 123456789 0 0 0
ctxt 987654321
btime 1700000000
processes 456789
procs_running 2
procs_blocked 0
softirq 12345678 0 1234567 0
`

/** Segunda lectura, 10 segundos después. */
export const STAT_DESPUES = `cpu  1234667 8901 234617 45679901 12365 0 6799 1021 0 0
cpu0 308666 2225 58654 11419975 3091 0 1700 255 0 0
cpu1 308667 2226 58654 11419976 3092 0 1701 256 0 0
cpu2 308666 2225 58654 11419975 3091 0 1700 255 0 0
cpu3 308668 2225 58655 11419975 3091 0 1698 255 0 0
intr 123457789 0 0 0
ctxt 987664321
btime 1700000000
processes 456799
procs_running 1
procs_blocked 0
`

export const MEMINFO = `MemTotal:       16305892 kB
MemFree:         1234567 kB
MemAvailable:    9876543 kB
Buffers:          234567 kB
Cached:          6543210 kB
SwapCached:            0 kB
Active:          8765432 kB
Inactive:        4321098 kB
SwapTotal:       2097148 kB
SwapFree:        2097148 kB
Dirty:               456 kB
Writeback:             0 kB
SReclaimable:     345678 kB
`

/** Kernel viejo: sin `MemAvailable`. */
export const MEMINFO_SIN_AVAILABLE = `MemTotal:       16305892 kB
MemFree:         1234567 kB
Buffers:          234567 kB
Cached:          6543210 kB
SwapTotal:             0 kB
SwapFree:              0 kB
SReclaimable:     345678 kB
`

export const LOADAVG = '0.52 0.58 0.59 2/1234 5678\n'

export const UPTIME = '1284300.45 4938271.23\n'

export const DISKSTATS = `   7       0 loop0 12 0 96 4 0 0 0 0 0 8 4 0 0 0 0 0 0
 259       0 nvme0n1 123456 7890 9876543 45678 234567 12345 8765432 56789 0 34567 102467 0 0 0 0 0 0
 259       1 nvme0n1p1 1234 78 98765 456 2345 123 87654 567 0 345 1023 0 0 0 0 0 0
   8       0 sda 45678 1234 3456789 12345 67890 2345 4567890 23456 0 12345 35801 0 0 0 0 0 0
   8       1 sda1 4567 123 345678 1234 6789 234 456789 2345 0 1234 3579 0 0 0 0 0 0
`

export const DISKSTATS_DESPUES = `   7       0 loop0 12 0 96 4 0 0 0 0 0 8 4 0 0 0 0 0 0
 259       0 nvme0n1 123556 7890 9896543 45778 234667 12345 8785432 56889 0 34667 102667 0 0 0 0 0 0
 259       1 nvme0n1p1 1234 78 98765 456 2345 123 87654 567 0 345 1023 0 0 0 0 0 0
   8       0 sda 45678 1234 3456789 12345 67890 2345 4567890 23456 0 12345 35801 0 0 0 0 0 0
   8       1 sda1 4567 123 345678 1234 6789 234 456789 2345 0 1234 3579 0 0 0 0 0 0
`

export const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9876543   12345    0    0    0     0          0         0  9876543   12345    0    0    0     0       0          0
  eth0: 1234567890 8765432   12    5    0     0          0      1234  987654321 6543210    3    1    0     0       0          0
docker0:   234567    1234    0    0    0     0          0         0     345678    2345    0    0    0     0       0          0
`

export const NET_DEV_DESPUES = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9876643   12355    0    0    0     0          0         0  9876643   12355    0    0    0     0       0          0
  eth0: 1234577890 8765632   14    6    0     0          0      1234  987664321 6543410    3    1    0     0       0          0
docker0:   244567    1334    0    0    0     0          0         0     355678    2445    0    0    0     0       0          0
`

export const PRESSURE_CPU = `some avg10=1.23 avg60=2.34 avg300=3.45 total=123456789
full avg10=0.00 avg60=0.00 avg300=0.00 total=0
`

/** `/proc/pressure/cpu` en kernels donde `full` no existe. */
export const PRESSURE_CPU_SIN_FULL = `some avg10=1.23 avg60=2.34 avg300=3.45 total=123456789
`

export const NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F91 0100007F:BCDE 01 00000000:00000000 00:00000000 00000000  1000        0 12346 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:1F92 0100007F:BCDF 06 00000000:00000000 03:00000C4E 00000000     0        0 0 3 0000000000000000
   3: 0100007F:1F93 0100007F:BCE0 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 20 4 30 10 -1
`

export const NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0050 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 23456 1 0000000000000000 100 0 0 10 0
`

/* Nótese `/mnt/disco\\040externo`: los espacios vienen escapados en octal, y
 * un parser que parte por espacios sin desescapar produce un punto de montaje
 * inexistente. */
export const MOUNTS = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
udev /dev devtmpfs rw,nosuid,relatime,size=8130560k 0 0
/dev/nvme0n1p2 / ext4 rw,relatime,errors=remount-ro 0 0
tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=1630592k 0 0
tmpfs /dev/shm tmpfs rw,nosuid,nodev 0 0
tmpfs /tmp tmpfs rw,nosuid,nodev 0 0
/dev/nvme0n1p1 /boot/efi vfat rw,relatime 0 0
/dev/sda1 /mnt/disco\\040externo ext4 rw,relatime 0 0
overlay /var/lib/docker/overlay2/abc123/merged overlay rw,relatime 0 0
cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime 0 0
`

/* El nombre del proceso trae espacios Y paréntesis. Un parser que corta por el
 * primer `)` o parte por espacios lee el resto de las columnas corridas y
 * devuelve el `rss` de otro campo. */
export const PID_STAT_SIMPLE =
  '1234 (postgres) S 1 1234 1234 0 -1 4194560 12345 0 6 0 456 789 0 0 20 0 5 0 987654 123456789 45678 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0\n'

export const PID_STAT_CON_ESPACIOS =
  '5678 (Web Content) S 1 5678 5678 0 -1 4194304 98765 0 12 0 1234 567 0 0 20 0 25 0 1987654 987654321 123456 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 1 0 0 0 0 0\n'

export const PID_STAT_CON_PARENTESIS =
  '9012 (raro(nombre)aca) R 1 9012 9012 0 -1 4194304 100 0 0 0 10 20 0 0 20 0 1 0 100 1000 999 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n'

export const PID_STATUS = `Name:	postgres
Umask:	0077
State:	S (sleeping)
Tgid:	1234
Pid:	1234
PPid:	1
Uid:	113	113	113	113
Gid:	119	119	119	119
VmRSS:	  178312 kB
`

export const OS_RELEASE = `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
ID=debian
`

export const PASSWD = `root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
postgres:x:113:119:PostgreSQL administrator,,,:/var/lib/postgresql:/bin/bash
vmstats:x:1000:1000::/home/vmstats:/bin/bash
`
