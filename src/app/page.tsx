"use client";

import { useState } from "react";
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
  Code,
  FileText,
  Users,
  Rocket,
  TrendingUp,
  CheckCircle,
  ArrowRight,
  Puzzle,
  BookOpen,
  Award,
  Lightbulb,
} from "lucide-react";

export default function Home() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"engineers" | "experts">("engineers");

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
                alt="Signal"
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
              Find People by Evidence,{" "}
              <span className="gradient-text-gold">Not Claims</span>
            </h1>
            <p className="mt-6 text-xl text-zinc-400 max-w-2xl">
              Discover engineers and experts based on what they&apos;ve actually done — real work, real research, real impact — using live web data and explainable evidence.
            </p>

            {/* Search Bar */}
            <div className="mt-10 max-w-2xl">
              <SearchBar onSearch={handleSearch} />
            </div>

            {/* CTA Links */}
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <button
                onClick={() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })}
                className="text-sm text-zinc-400 hover:text-white flex items-center gap-1 transition-colors"
              >
                See how it works <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* The Problem Section */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Titles, resumes, and profiles are easy to write.
            </h2>
            <p className="mt-2 text-3xl sm:text-4xl font-bold gradient-text-purple">
              Real expertise is hard to fake.
            </p>

            <p className="mt-8 text-lg text-zinc-400">
              Most people-search tools rely on:
            </p>

            <ul className="mt-4 space-y-3">
              <li className="flex items-center gap-3 text-zinc-400">
                <span className="h-2 w-2 bg-red-500/60 rounded-full" />
                Self-reported claims
              </li>
              <li className="flex items-center gap-3 text-zinc-400">
                <span className="h-2 w-2 bg-red-500/60 rounded-full" />
                Outdated databases
              </li>
              <li className="flex items-center gap-3 text-zinc-400">
                <span className="h-2 w-2 bg-red-500/60 rounded-full" />
                Opaque scoring
              </li>
            </ul>

            <p className="mt-6 text-lg text-zinc-300">
              They tell you who people <span className="italic">say</span> they are — not what they&apos;ve actually <span className="text-white font-medium">done</span>.
            </p>
          </div>
        </div>
      </section>

      {/* The Signal Way */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              The Signal Way
            </h2>
            <p className="mt-4 text-xl text-zinc-400">
              Signal is a <span className="text-white font-medium">real-time, explainable</span> people intelligence engine.
            </p>
            <p className="mt-4 text-lg text-zinc-400">
              We search the live web and verify people using evidence, not assumptions:
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <div className="flex items-start gap-3">
              <Code className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Code and open-source contributions</h4>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <FileText className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Research papers, citations, and patents</h4>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Lightbulb className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Public technical work and projects</h4>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle className="h-6 w-6 text-purple-400 mt-1 flex-shrink-0" />
              <div>
                <h4 className="text-white font-medium">Verified affiliations and activity timelines</h4>
              </div>
            </div>
          </div>

          <p className="mt-8 text-lg text-zinc-300">
            Every result comes with <span className="text-white font-medium">clear reasoning and sources</span>.
          </p>
        </div>
      </section>

      {/* Who Are You Looking For? */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-8">
            Who Are You Looking For?
          </h2>

          {/* Tabs */}
          <div className="flex gap-4 mb-8">
            <button
              onClick={() => setActiveTab("engineers")}
              className={`px-6 py-3 rounded-lg font-medium transition-all flex items-center gap-2 ${
                activeTab === "engineers"
                  ? "bg-purple-600 text-white"
                  : "bg-[#141428] text-zinc-400 hover:text-white border border-purple-500/20"
              }`}
            >
              <Code className="h-5 w-5" />
              Engineers
            </button>
            <button
              onClick={() => setActiveTab("experts")}
              className={`px-6 py-3 rounded-lg font-medium transition-all flex items-center gap-2 ${
                activeTab === "experts"
                  ? "bg-purple-600 text-white"
                  : "bg-[#141428] text-zinc-400 hover:text-white border border-purple-500/20"
              }`}
            >
              <Brain className="h-5 w-5" />
              Experts
            </button>
          </div>

          {/* Tab Content */}
          {activeTab === "engineers" && (
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <h3 className="text-2xl font-bold text-white mb-4">
                Find engineers by real work, not titles
              </h3>
              <p className="text-zinc-400 mb-6">Signal analyzes:</p>
              <ul className="space-y-3 mb-8">
                <li className="flex items-center gap-3 text-zinc-300">
                  <Github className="h-5 w-5 text-purple-400" />
                  GitHub repositories and activity
                </li>
                <li className="flex items-center gap-3 text-zinc-300">
                  <Code className="h-5 w-5 text-purple-400" />
                  Languages, frameworks, and projects
                </li>
                <li className="flex items-center gap-3 text-zinc-300">
                  <TrendingUp className="h-5 w-5 text-purple-400" />
                  Open-source impact and consistency
                </li>
              </ul>

              <div className="bg-[#0D0D1A] rounded-lg p-4 mb-6">
                <p className="text-sm text-zinc-500 mb-2">Use cases:</p>
                <ul className="space-y-1 text-sm text-zinc-400">
                  <li>• Hiring senior engineers</li>
                  <li>• Finding niche technical specialists</li>
                  <li>• Evaluating hands-on experience</li>
                </ul>
              </div>

              <button
                onClick={() => handleSearch("Senior React engineers in SF")}
                className="text-purple-400 hover:text-purple-300 font-medium flex items-center gap-2 transition-colors"
              >
                Show me engineers by real work <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}

          {activeTab === "experts" && (
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <h3 className="text-2xl font-bold text-white mb-4">
                Discover experts by evidence, not claims
              </h3>
              <p className="text-zinc-400 mb-6">Signal analyzes:</p>
              <ul className="space-y-3 mb-8">
                <li className="flex items-center gap-3 text-zinc-300">
                  <BookOpen className="h-5 w-5 text-purple-400" />
                  Publications and citations
                </li>
                <li className="flex items-center gap-3 text-zinc-300">
                  <GraduationCap className="h-5 w-5 text-purple-400" />
                  Research affiliations and authority signals
                </li>
                <li className="flex items-center gap-3 text-zinc-300">
                  <Award className="h-5 w-5 text-purple-400" />
                  Patents, papers, and public contributions
                </li>
              </ul>

              <div className="bg-[#0D0D1A] rounded-lg p-4 mb-6">
                <p className="text-sm text-zinc-500 mb-2">Use cases:</p>
                <ul className="space-y-1 text-sm text-zinc-400">
                  <li>• Research and diligence</li>
                  <li>• Advisory and expert sourcing</li>
                  <li>• Thought leadership validation</li>
                </ul>
              </div>

              <button
                onClick={() => handleSearch("AI researchers publishing in NLP")}
                className="text-purple-400 hover:text-purple-300 font-medium flex items-center gap-2 transition-colors"
              >
                Show me experts by evidence <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 bg-[#141428]/50">
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
                Use natural language:
              </p>
              <div className="space-y-2 font-mono text-sm">
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;Senior React engineers in SF&quot;</div>
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;AI researchers in NLP&quot;</div>
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;Fintech founders with payments experience&quot;</div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">2</span>
                <h3 className="text-xl font-semibold text-white">Signal searches the live web</h3>
              </div>
              <p className="text-zinc-400">
                We discover relevant public profiles across trusted sources.
              </p>
              <div className="mt-6 flex items-center gap-2">
                <Globe className="h-5 w-5 text-purple-400" />
                <span className="text-zinc-300">Real-time discovery</span>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">3</span>
                <h3 className="text-xl font-semibold text-white">Deep research, on demand</h3>
              </div>
              <p className="text-zinc-400">
                Click any result to analyze:
              </p>
              <ul className="mt-4 space-y-2 text-zinc-300">
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 bg-purple-400 rounded-full" />
                  Technical output
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 bg-purple-400 rounded-full" />
                  Research and authority
                </li>
                <li className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 bg-purple-400 rounded-full" />
                  Cross-platform verification
                </li>
              </ul>
            </div>

            {/* Step 4 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">4</span>
                <h3 className="text-xl font-semibold text-white">Clear confidence, explained</h3>
              </div>
              <p className="text-zinc-400 mb-4">
                Every profile includes:
              </p>
              <ul className="space-y-2 text-zinc-300">
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-purple-400" />
                  A confidence level
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-purple-400" />
                  The signals used
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-purple-400" />
                  Links to original sources
                </li>
              </ul>
              <p className="mt-4 text-white font-medium">No black boxes.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Why Signal Is Different */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Why Signal Is Different
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Search className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Evidence-first</h4>
              <p className="text-sm text-zinc-400">We verify real output, not keywords.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Zap className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Real-time</h4>
              <p className="text-sm text-zinc-400">No stale databases. No waiting for re-indexes.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Brain className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Explainable</h4>
              <p className="text-sm text-zinc-400">You always know why a person matched.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Puzzle className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Role-aware</h4>
              <p className="text-sm text-zinc-400">Engineers, researchers, founders — each analyzed differently.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Shield className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Respectful by design</h4>
              <p className="text-sm text-zinc-400">Public data only. On-demand analysis. Transparent sources.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Who Uses Signal */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Who Uses Signal
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="group">
              <Users className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Engineering & recruiting teams</h4>
            </div>
            <div className="group">
              <Rocket className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Founders building early teams</h4>
            </div>
            <div className="group">
              <TrendingUp className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Investors & diligence teams</h4>
            </div>
            <div className="group">
              <BookOpen className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Researchers & analysts</h4>
            </div>
            <div className="group">
              <CheckCircle className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Operators validating expertise</h4>
            </div>
          </div>
        </div>
      </section>

      {/* Example Searches */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-8">
            Example Searches
          </h2>

          <div className="grid sm:grid-cols-2 gap-4 max-w-3xl">
            {[
              "5 frontend engineers with React and WebGL",
              "Machine learning researchers publishing in NLP",
              "Founders with payments and fintech experience",
              "Open-source contributors to distributed systems"
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

      {/* Built for Trust */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-6">
              Built for Trust
            </h2>
            <p className="text-zinc-400 mb-6">Signal shows:</p>
            <ul className="space-y-3 text-zinc-300">
              <li className="flex items-center gap-3">
                <span className="h-2 w-2 bg-purple-500 rounded-full" />
                Where each insight came from
              </li>
              <li className="flex items-center gap-3">
                <span className="h-2 w-2 bg-purple-500 rounded-full" />
                When it was last verified
              </li>
              <li className="flex items-center gap-3">
                <span className="h-2 w-2 bg-purple-500 rounded-full" />
                What evidence supports it
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
            Start Finding People by Evidence
          </h2>
          <p className="text-xl text-zinc-400 mb-10">
            Discover professionals the way modern teams should:<br />
            <span className="text-white">real work, real research, real impact.</span>
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
                alt="Signal"
                width={32}
                height={32}
                className="h-8 w-8 object-cover object-[center_15%] scale-110"
                unoptimized
              />
            </div>
            <span className="text-sm font-medium text-[#F59E0B]">Signal</span>
          </div>
          <p className="text-sm text-zinc-500">
            Find people by evidence, not claims
          </p>
        </div>
      </footer>
    </div>
  );
}
