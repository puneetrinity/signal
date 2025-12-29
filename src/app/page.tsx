"use client";

import { useRouter } from "next/navigation";
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
  Layers,
  Mail,
  Eye,
  Sparkles,
} from "lucide-react";

export default function Home() {
  const router = useRouter();

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
              Search for professionals in natural language. Signal discovers their identities across 20+ platforms — GitHub, Google Scholar, npm, arXiv, and more — with AI-powered summaries and confidence scoring.
            </p>

            {/* Login Button */}
            <div className="mt-10">
              <button
                onClick={() => router.push("/sign-in")}
                className="px-8 py-4 bg-purple-600 hover:bg-purple-500 text-white font-semibold rounded-lg transition-colors text-lg"
              >
                Login
              </button>
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

      {/* Platform Discovery Section */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <div className="max-w-3xl mb-12">
            <h2 className="text-3xl sm:text-4xl font-bold text-white">
              Cross-Platform Identity Discovery
            </h2>
            <p className="mt-4 text-xl text-zinc-400">
              Signal searches <span className="text-white font-medium">20+ platforms</span> to build a complete picture of a person&apos;s real work.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* Engineers */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Code className="h-8 w-8 text-purple-400 mb-4" />
              <h4 className="text-white font-semibold mb-3">For Engineers</h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>GitHub & GitLab</li>
                <li>npm & PyPI packages</li>
                <li>Stack Overflow</li>
                <li>Docker Hub</li>
                <li>LeetCode</li>
              </ul>
            </div>

            {/* Researchers */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <GraduationCap className="h-8 w-8 text-purple-400 mb-4" />
              <h4 className="text-white font-semibold mb-3">For Researchers</h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>Google Scholar</li>
                <li>ORCID</li>
                <li>arXiv & Semantic Scholar</li>
                <li>ResearchGate</li>
                <li>Patents (USPTO/WIPO)</li>
              </ul>
            </div>

            {/* ML/Data */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Brain className="h-8 w-8 text-purple-400 mb-4" />
              <h4 className="text-white font-semibold mb-3">For ML & Data</h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>Hugging Face</li>
                <li>Kaggle</li>
                <li>Papers with Code</li>
                <li>OpenReview</li>
              </ul>
            </div>

            {/* Content & Business */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Lightbulb className="h-8 w-8 text-purple-400 mb-4" />
              <h4 className="text-white font-semibold mb-3">Content & Business</h4>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>Medium & Substack</li>
                <li>Dev.to & YouTube</li>
                <li>Crunchbase & AngelList</li>
                <li>SEC filings</li>
              </ul>
            </div>
          </div>
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
                <h3 className="text-xl font-semibold text-white">Search in natural language</h3>
              </div>
              <p className="text-zinc-400 mb-4">
                Describe who you&apos;re looking for:
              </p>
              <div className="space-y-2 font-mono text-sm">
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;Senior React engineers in SF&quot;</div>
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;ML researchers publishing in NLP&quot;</div>
                <div className="bg-[#0D0D1A] rounded-lg px-4 py-2 text-purple-300">&quot;Fintech founders with payments experience&quot;</div>
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">2</span>
                <h3 className="text-xl font-semibold text-white">Get candidate results</h3>
              </div>
              <p className="text-zinc-400">
                Signal searches the live web and returns up to 50 matching candidates with preview information.
              </p>
              <div className="mt-6 flex items-center gap-2">
                <Globe className="h-5 w-5 text-purple-400" />
                <span className="text-zinc-300">Real-time web discovery</span>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">3</span>
                <h3 className="text-xl font-semibold text-white">Deep enrichment on click</h3>
              </div>
              <p className="text-zinc-400 mb-4">
                Click any candidate to discover their identities across 20+ platforms:
              </p>
              <ul className="space-y-2 text-zinc-300 text-sm">
                <li className="flex items-center gap-2">
                  <Github className="h-4 w-4 text-purple-400" />
                  GitHub, npm, PyPI, Stack Overflow
                </li>
                <li className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-purple-400" />
                  Google Scholar, ORCID, arXiv
                </li>
                <li className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-purple-400" />
                  Hugging Face, Kaggle, Medium, and more
                </li>
              </ul>
            </div>

            {/* Step 4 */}
            <div className="bg-[#141428] border border-purple-500/20 rounded-2xl p-8">
              <div className="flex items-center gap-4 mb-4">
                <span className="stat-number text-3xl">4</span>
                <h3 className="text-xl font-semibold text-white">AI summary & confidence scores</h3>
              </div>
              <p className="text-zinc-400 mb-4">
                Get an AI-generated profile with:
              </p>
              <ul className="space-y-2 text-zinc-300">
                <li className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-400" />
                  Skills, highlights, and talking points
                </li>
                <li className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-purple-400" />
                  Confidence scores for each identity
                </li>
                <li className="flex items-center gap-2">
                  <Eye className="h-4 w-4 text-purple-400" />
                  Links to original sources as evidence
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Key Features */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Key Features
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Search className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Natural Language Search</h4>
              <p className="text-sm text-zinc-400">Search for people the way you think. AI parses your query to understand roles, skills, locations, and seniority.</p>
            </div>
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Layers className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Cross-Platform Discovery</h4>
              <p className="text-sm text-zinc-400">Automatically discover identities across GitHub, Google Scholar, npm, Kaggle, Hugging Face, and 15+ more platforms.</p>
            </div>
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Sparkles className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">AI-Powered Summaries</h4>
              <p className="text-sm text-zinc-400">Get intelligent summaries with skills, highlights, talking points, and caveats — generated from verified evidence.</p>
            </div>
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <CheckCircle className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Confidence Scoring</h4>
              <p className="text-sm text-zinc-400">Every discovered identity has a confidence score. High, medium, and low confidence tiers help you prioritize review.</p>
            </div>
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Mail className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Email Discovery</h4>
              <p className="text-sm text-zinc-400">Extract email addresses from GitHub commit history for confirmed identities.</p>
            </div>
            <div className="bg-[#141428] border border-purple-500/20 rounded-xl p-6">
              <Eye className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Review Queue</h4>
              <p className="text-sm text-zinc-400">Manage identity confirmations in a centralized queue. Confirm or reject matches with full context and evidence.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Why Signal Is Different */}
      <section className="py-20 bg-[#141428]/50">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Why Signal Is Different
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Search className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Evidence-first</h4>
              <p className="text-sm text-zinc-400">We verify real output across platforms, not self-reported claims.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Zap className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Real-time</h4>
              <p className="text-sm text-zinc-400">Live web search. No stale databases or outdated profiles.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Brain className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Explainable</h4>
              <p className="text-sm text-zinc-400">Every match comes with reasoning, sources, and confidence scores.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Puzzle className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Role-aware</h4>
              <p className="text-sm text-zinc-400">Engineers, researchers, founders — each searched on relevant platforms.</p>
            </div>
            <div className="bg-[#0D0D1A] border border-purple-500/20 rounded-xl p-6">
              <Shield className="h-8 w-8 text-[#F59E0B] mb-4" />
              <h4 className="text-white font-semibold mb-2">Privacy-respecting</h4>
              <p className="text-sm text-zinc-400">Public data only. On-demand analysis. Human-in-the-loop confirmation.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Who Uses Signal */}
      <section className="py-20 border-t border-purple-500/10">
        <div className="max-w-6xl mx-auto px-4">
          <h2 className="text-3xl sm:text-4xl font-bold text-white mb-12">
            Who Uses Signal
          </h2>

          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-6">
            <div className="group">
              <Users className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Recruiting teams</h4>
              <p className="text-sm text-zinc-400 mt-2">Find engineers by actual code and contributions</p>
            </div>
            <div className="group">
              <Rocket className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Startup founders</h4>
              <p className="text-sm text-zinc-400 mt-2">Build early teams with verified expertise</p>
            </div>
            <div className="group">
              <TrendingUp className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Investors</h4>
              <p className="text-sm text-zinc-400 mt-2">Validate founder and team backgrounds</p>
            </div>
            <div className="group">
              <BookOpen className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Researchers</h4>
              <p className="text-sm text-zinc-400 mt-2">Find collaborators by publication record</p>
            </div>
            <div className="group">
              <Award className="h-8 w-8 text-purple-400 mb-4 group-hover:text-purple-300 transition-colors" />
              <h4 className="text-white font-semibold">Expert networks</h4>
              <p className="text-sm text-zinc-400 mt-2">Source advisors with proven expertise</p>
            </div>
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
            Search in natural language. Discover identities across 20+ platforms.<br />
            <span className="text-white">Get AI summaries with confidence scores.</span>
          </p>

          <div className="max-w-xl mx-auto">
            <button
              onClick={() => router.push("/sign-in")}
              className="px-10 py-4 bg-gradient-to-r from-purple-600 to-purple-500 hover:from-purple-500 hover:to-purple-400 text-white font-semibold rounded-lg transition-all text-lg shadow-lg shadow-purple-500/25"
            >
              Try now for free
            </button>
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
