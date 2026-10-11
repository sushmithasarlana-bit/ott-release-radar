import { Suspense } from "react";
import Dashboard from "./Dashboard";
import styles from "./page.module.css";

export default function Home() {
  return (
    <Suspense
      fallback={
        <main className={styles.page} aria-busy="true">
          <section className={styles.hero}>
            <div className={styles.heroInner}>
              <p className={styles.eyebrow}>OTT Release Radar</p>
              <h1 className={styles.heroTitle}>Tuning in…</h1>
            </div>
          </section>
        </main>
      }
    >
      <Dashboard />
    </Suspense>
  );
}
