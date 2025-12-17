"use client";

import { useRouter } from "next/navigation";
import { SearchBar } from "@/components/SearchBar";
import Image from "next/image";
import {
  Zap,
  Search,
  Brain,
  Globe,
  Shield,
  Github,
  GraduationCap,
  Briefcase,
  MessageSquare,
  Users,
  Rocket,
  TrendingUp,
  Code
} from "lucide-react";

export default function Home() {
  const router = useRouter();

  const handleSearch = (query: string) => {
    router.push(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <div className="min-h-screen bg-[#0D0D1A]">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background gradient */}
        <div className="absolute inset-0 bg-gradient-to-br from-purple-900/20 via-transparent to-amber-900/10" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-purple-500/10 rounded-full blur-3xl" />

        <div className="relative max-w-6xl mx-auto px-4 pt-16 pb-24">
          {/* Logo */}
          <div className="flex items-center gap-3 mb-16">
            <div className="h-9 w-9 overflow-hidden rounded-lg">
              <Image
                src="/logo.png"
                alt="VantaHire"
                width={48}
                height={48}
                className="h-12 w-12 object-cover object-[center_15%] scale-110"
                priority
                unoptimized
              />
            </div>
            <span className="text-xl font-semibold text-[#F59E0B]">Signal</span>
          </div>

          {/* Hero Content */}
          <div className="max-w-4xl">
            <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold text-white leading-tight">
              Find the Right Professionals.{" "}
              <span className="gradient-text-gold">Instantly.</span>
            </h1>
            <p className="mt-6 text-xl text-zinc-400 max-w-2xl">
              Search the web like an expert recruiter — using AI, real-time data, and public sources.
            </p>

            {/* Search Bar */}
            <div className="mt-10 max-w-2xl">
              <SearchBar onSearch={handleSearch} />
            </div>

            {/* Example searches */}
            <div className="mt-6 flex flex-wrap gap-2">
              <span className="text-sm text-zinc-500">Try:</span>
              {["10 AI engineers in SF", "Senior Python developers Berlin", "Fintech founders NYC"].map((example) => (
                <button
                  key={example}
                  onClick={() => handleSearch(example)}
                  className="text-sm text-purple-400 hover:text-purple-300 transition-colors"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Stop Guessing Section */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Stop Guessing. <span className="gradient-text-purple">Start Finding.</span>
            </h2>
            <p className="mt-6 text-lg text-zinc-400">
              Traditional people search tools are slow, expensive, and opaque.
              Signal gives you direct access to professionals on the open web, ranked and explained — no walled gardens, no outdated databases.
            </p>
            <p className="mt-4 text-lg text-zinc-300 font-medium">
              Just type what you need. We&apos;ll do the rest.
            </p>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            How It Works
          </h2>

          <div className="grid md:grid-cols-2 gap-8">
            {/* Step 1 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">1</span>
                <h3 className="text-xl font-semibold text-white">Describe who you&apos;re looking for</h3>
              </div>
              <p className="text-zinc-400 mb-4">
                Use natural language — roles, skills, locations, seniority.
              </p>
              <div className="space-y-2 font-mono text-sm">
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;10 AI engineers in San Francisco&quot;</div>
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;Senior backend developers with Python in Berlin&quot;</div>
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;Fintech founders in New York&quot;</div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">2</span>
                <h3 className="text-xl font-semibold text-white">Signal searches the web in real time</h3>
              </div>
              <p className="text-zinc-400">
                We discover relevant public profiles using advanced search intelligence.
              </p>
              <div className="mt-6 flex items-center gap-2">
                <Globe className="h-5 w-5 text-purple-400" />
                <span className="text-zinc-300">Live web search</span>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">3</span>
                <h3 className="text-xl font-semibold text-white">Deep research, on demand</h3>
              </div>
              <p className="text-zinc-400">
                Click any result to instantly analyze public sources like GitHub, research papers, patents, and more.
              </p>
            </div>

            {/* Step 4 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">4</span>
                <h3 className="text-xl font-semibold text-white">Clear confidence, explained</h3>
              </div>
              <p className="text-zinc-400">
                Every profile includes evidence and a confidence score — so you know why it&apos;s a match.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Built for Precision */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Built for Precision, <span className="gradient-text-gold">Not Noise</span>
            </h2>
            <p className="mt-4 text-xl text-zinc-400">
              Signal doesn&apos;t guess. <span className="text-white font-medium">It verifies.</span>
            </p>
            <p className="mt-4 text-zinc-400">
              We cross-check professionals across trusted public sources:
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="flex items-start gap-3">
              <Github className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Engineering activity</h4>
                <p className="text-sm text-zinc-500">GitHub, Stack Overflow, packages</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <GraduationCap className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Research and authority</h4>
                <p className="text-sm text-zinc-500">Google Scholar, ORCID, patents</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Briefcase className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Business signals</h4>
                <p className="text-sm text-zinc-500">Leadership and founding roles</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <MessageSquare className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Public presence</h4>
                <p className="text-sm text-zinc-500">Writing, talks, community</p>
              </div>
            </div>
          </div>

          <p className="mt-8 text-zinc-400">
            All evidence is transparent. <span className="text-white">No black boxes.</span>
          </p>
        </div>
      </section>

      {/* Why Teams Choose Signal */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Why Teams Choose Signal
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Zap className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Fast</h4>
              <p className="text-sm text-zinc-400">Get results in seconds, not days.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Search className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Accurate</h4>
              <p className="text-sm text-zinc-400">AI-powered search + cross-verification reduces false positives.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Brain className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Explainable</h4>
              <p className="text-sm text-zinc-400">Every match shows why it was selected.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Globe className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Real-Time</h4>
              <p className="text-sm text-zinc-400">No stale databases. Results from the live web.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Shield className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Respectful</h4>
              <p className="text-sm text-zinc-400">Public web data only, analyzed on demand.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Who It's For */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Who It&apos;s For
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="group">
              <Users className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold mb-2">Recruiters & Talent Teams</h4>
              <p className="text-sm text-zinc-400">Find hard-to-reach professionals faster.</p>
            </div>
            <div className="group">
              <Rocket className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold mb-2">Founders & Operators</h4>
              <p className="text-sm text-zinc-400">Identify candidates, advisors, or partners.</p>
            </div>
            <div className="group">
              <TrendingUp className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold mb-2">Investors & Researchers</h4>
              <p className="text-sm text-zinc-400">Discover experts by domain, not just job titles.</p>
            </div>
            <div className="group">
              <Code className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold mb-2">Technical Teams</h4>
              <p className="text-sm text-zinc-400">Explore engineers, researchers, and builders by real output.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Example Searches */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-8">
            Example Searches
          </h2>

          <div className="grid sm:grid-cols-2 gap-4 max-w-3xl">
            {[
              "5 Machine Learning Engineers in London with PyTorch",
              "Startup CTOs in fintech, Europe",
              "AI researchers publishing in NLP",
              "Frontend engineers with React and WebGL"
            ].map((search) => (
              <button
                key={search}
                onClick={() => handleSearch(search)}
                className="text-left bg-[#0D0D1A] border border-purple-500/20 rounded-lg px-5 py-4 text-zinc-300 hover:border-purple-500/50 hover:text-white transition-all group"
              >
                <span className="text-purple-400 group-hover:text-purple-300 mr-2">→</span>
                {search}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Transparent Results */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6">
              Transparent Results You Can Trust
            </h2>
            <p className="text-zinc-400 mb-6">Signal shows:</p>
            <ul className="space-y-3 text-zinc-300">
              <li className="flex items-center gap-3">
                <span className="h-2 w-2 bg-purple-500 rounded-full" />
                Where each result came from
              </li>
              <li className="flex items-center gap-3">
                <span className="h-2 w-2 bg-purple-500 rounded-full" />
                What evidence supports the match
              </li>
              <li className="flex items-center gap-3">
                <span className="h-2 w-2 bg-purple-500 rounded-full" />
                When the data was last verified
              </li>
            </ul>
            <p className="mt-6 text-zinc-400">
              You stay in control — save profiles, revisit searches, and build your own shortlist.
            </p>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 bg-gradient-to-t from-purple-900/20 to-transparent">
        <div className="max-w-4xl mx-auto px-4 text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">
            Start Searching Smarter
          </h2>
          <p className="text-xl text-zinc-400 mb-10">
            Find professionals the way modern teams should:<br />
            <span className="text-white">fast, transparent, and powered by real-world signals.</span>
          </p>

          <div className="max-w-xl mx-auto">
            <SearchBar onSearch={handleSearch} />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 overflow-hidden rounded">
              <Image
                src="/logo.png"
                alt="VantaHire"
                width={32}
                height={32}
                className="h-8 w-8 object-cover object-[center_15%] scale-110"
                unoptimized
              />
            </div>
            <span className="text-sm font-medium text-[#F59E0B]">Signal</span>
            <span className="text-sm text-zinc-500">by VantaHire</span>
          </div>
          <p className="text-sm text-zinc-500">
            Powered by AI and real-time web data
          </p>
        </div>
      </footer>
    </div>
  );
}
