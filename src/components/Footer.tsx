export default function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-20 border-t border-(--line) px-4 py-8">
      <div className="page-wrap flex items-center justify-between text-sm max-w-5xl mx-auto">
        <p>&copy; {year} Your Name</p>
        <p className="text-xs opacity-50">Built with TanStack Start</p>
      </div>
    </footer>
  );
}
