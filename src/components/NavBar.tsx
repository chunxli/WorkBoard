import Link from "next/link";
import { LayoutDashboard, LogIn, LogOut } from "lucide-react";
import GlobalSearch from "@/components/GlobalSearch";
import NavLinks from "@/components/NavLinks";
import ThemeToggle from "@/components/ThemeToggle";
import { auth, signIn, signOut } from "@/auth";

export default async function NavBar() {
  const session = await auth();

  return (
    <nav className="sticky top-0 z-40 border-b border-neutral-800/90 bg-[var(--nav-background)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6 lg:flex-nowrap lg:px-8">
        <Link
          href="/work"
          className="order-1 flex shrink-0 items-center gap-2.5 whitespace-nowrap text-white"
        >
          <span className="grid size-8 place-items-center rounded-md border border-emerald-700/50 bg-emerald-950/70 text-emerald-300 shadow-[0_0_24px_rgba(67,209,158,0.08)]">
            <LayoutDashboard size={17} strokeWidth={2} aria-hidden="true" />
          </span>
          <span className="text-[15px] font-bold">Work Board</span>
        </Link>
        {session?.user && (
          <div className="nav-scroll order-3 w-full overflow-x-auto lg:order-2 lg:w-auto lg:overflow-visible">
            <NavLinks />
          </div>
        )}
        {session?.user && (
          <div className="order-4 w-full lg:order-3 lg:ml-auto lg:w-72">
            <GlobalSearch />
          </div>
        )}
        <div className="order-2 ml-auto flex items-center gap-2 whitespace-nowrap text-sm lg:order-4 lg:ml-0">
          <ThemeToggle />
          {session?.user ? (
            <>
              <span className="hidden size-8 place-items-center rounded-full border border-neutral-700 bg-neutral-800 text-xs font-bold text-neutral-200 xl:grid">
                {(session.user.name ?? session.user.email ?? "U").slice(0, 1).toUpperCase()}
              </span>
              <form
                action={async () => {
                  "use server";
                  await signOut();
                }}
              >
                <button
                  type="submit"
                  aria-label="Sign out"
                  title="Sign out"
                  className="grid size-9 place-items-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-white"
                >
                  <LogOut size={16} aria-hidden="true" />
                </button>
              </form>
            </>
          ) : (
            <form
              action={async () => {
                "use server";
                await signIn("microsoft-entra-id");
              }}
            >
              <button
                type="submit"
                className="flex items-center gap-2 rounded-md bg-emerald-500 px-3 py-2 font-semibold text-[var(--on-accent)] hover:bg-emerald-400"
              >
                <LogIn size={16} aria-hidden="true" />
                Sign in with Microsoft
              </button>
            </form>
          )}
        </div>
      </div>
    </nav>
  );
}

