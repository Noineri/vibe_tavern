/*
 * seccomp_shim: turn Android's seccomp SIGSYS traps into ENOSYS for the
 * native server process.
 *
 * Android's app seccomp policy answers syscalls outside its allowlist with
 * SECCOMP_RET_TRAP: the kernel skips the call and raises SIGSYS, which kills
 * the process by default. Bun 1.4.x calls close_range(2) first thing at
 * startup (bun_initialize_process), and the Android 10-12 allowlist lacks it,
 * so the server died with exit 159 before printing anything (issue #47).
 * Bun.serve {dir} routes (resolveStaticDirRoutes) open files with openat2(2),
 * which no Android release allows, so every version needs the shim once the
 * browser requests a file under /assets/.
 *
 * ServerService loads this library into the server through LD_PRELOAD. Its
 * constructor installs a SIGSYS handler before Bun's own code runs. For a
 * seccomp trap (si_code == SYS_SECCOMP) the handler writes -ENOSYS into the
 * return register and resumes, so the caller's ENOSYS fallback runs. Each
 * distinct trapped syscall number is logged once to stderr, which the
 * launcher writes to server.log.
 *
 * Keep this in C against bionic's headers: bionic pads uc_sigmask to 128
 * bytes before uc_mcontext, and hand-rolled ucontext layouts (the Rust libc
 * crate's included) write to the wrong offset.
 *
 * Removal: this is the same mechanism as oven-sh/bun#39775. Once a stable
 * Bun ships it and the repo bumps to that Bun, delete this library, its
 * CMake/Gradle wiring and the LD_PRELOAD line in ServerService.kt.
 * See docs/architecture/decisions.md (AD-026).
 */

#include <errno.h>
#include <signal.h>
#include <stdatomic.h>
#include <string.h>
#include <ucontext.h>
#include <unistd.h>

#ifndef SYS_SECCOMP
#define SYS_SECCOMP 1
#endif

/* One log line per distinct syscall number; the arm64 table is < 512. */
#define TRACKED_SYSCALLS 512
static atomic_uchar seen[TRACKED_SYSCALLS];

/* Only async-signal-safe calls below: write(2), no stdio. */
static void write_str(const char* s) {
	(void)!write(STDERR_FILENO, s, strlen(s));
}

static void write_uint(unsigned int value) {
	char buf[12];
	int i = sizeof(buf);
	do {
		buf[--i] = (char)('0' + value % 10);
		value /= 10;
	} while (value != 0 && i > 0);
	(void)!write(STDERR_FILENO, buf + i, sizeof(buf) - i);
}

static void on_sigsys(int sig, siginfo_t* info, void* context) {
	if (info == NULL || info->si_code != SYS_SECCOMP || context == NULL) {
		/* A SIGSYS sent with kill(2): keep the default meaning. */
		signal(sig, SIG_DFL);
		raise(sig);
		return;
	}

	int saved_errno = errno;
	unsigned int nr = (unsigned int)info->si_syscall;
	if (nr >= TRACKED_SYSCALLS || atomic_exchange(&seen[nr], 1) == 0) {
		write_str("seccomp-shim: syscall ");
		write_uint(nr);
		write_str(" trapped, returning ENOSYS\n");
	}

	ucontext_t* uc = (ucontext_t*)context;
#if defined(__aarch64__)
	uc->uc_mcontext.regs[0] = (unsigned long long)(long long)-ENOSYS;
#elif defined(__x86_64__)
	uc->uc_mcontext.gregs[REG_RAX] = -ENOSYS;
#else
#error "seccomp_shim: unsupported architecture"
#endif
	errno = saved_errno;
}

__attribute__((constructor)) static void install_sigsys_handler(void) {
	struct sigaction action;
	memset(&action, 0, sizeof(action));
	action.sa_sigaction = on_sigsys;
	action.sa_flags = SA_SIGINFO | SA_ONSTACK;
	sigemptyset(&action.sa_mask);
	if (sigaction(SIGSYS, &action, NULL) == 0) {
		write_str("seccomp-shim: SIGSYS handler installed\n");
	} else {
		write_str("seccomp-shim: failed to install SIGSYS handler\n");
	}

	/* A trap on a blocked SIGSYS kills the process regardless of the handler. */
	sigset_t unblock;
	sigemptyset(&unblock);
	sigaddset(&unblock, SIGSYS);
	sigprocmask(SIG_UNBLOCK, &unblock, NULL);
}
