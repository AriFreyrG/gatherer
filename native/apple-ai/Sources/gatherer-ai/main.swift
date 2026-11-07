// gatherer-ai: one request in on stdin (JSON), one answer out on stdout (JSON), then exit.
//
//   {"cmd":"status"}
//     -> {"ok":true,"available":true}  or  {"ok":true,"available":false,"reason":"…"}
//   {"cmd":"summarize","title":"…","url":"…","text":"…","subjects":["…"]}
//     -> {"ok":true,"summary":"…","topics":["…"]}
//   {"cmd":"organize","notes":[{"id":"…","title":"…","summary":"…"}],"subjects":["…"]}
//     -> {"ok":true,"assignments":[{"id":"…","subject":"…"}]}
//
// Failures -> {"ok":false,"code":"…","error":"…"}. Everything runs on device; nothing leaves the Mac.
import Foundation
import FoundationModels

struct Request: Decodable {
    struct Note: Decodable { let id: String; let title: String?; let summary: String? }
    let cmd: String
    let title: String?
    let url: String?
    let text: String?
    let subjects: [String]?
    let notes: [Note]?
}

@Generable
struct NoteInsight {
    @Guide(description: "Two or three plain sentences saying what the page is about, under 70 words, in the page's language")
    var summary: String
    @Guide(description: "One to three short subject labels, 1-4 words each, sentence case, most fitting first", .count(1...3))
    var topics: [String]
}

@Generable
struct Grouping {
    @Generable
    struct Assignment {
        @Guide(description: "The note number from the list")
        var number: Int
        @Guide(description: "Subject label, 1-4 words, sentence case")
        var subject: String
    }
    @Guide(description: "One assignment for every numbered note")
    var assignments: [Assignment]
}

func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false,\"code\":\"encode\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String, _ message: String) -> Never {
    emit(["ok": false, "code": code, "error": message])
    exit(1)
}

func unavailableReason(_ model: SystemLanguageModel) -> String? {
    switch model.availability {
    case .available: return nil
    case .unavailable(.deviceNotEligible): return "This Mac does not support Apple Intelligence."
    case .unavailable(.appleIntelligenceNotEnabled): return "Apple Intelligence is turned off in System Settings."
    case .unavailable(.modelNotReady): return "Apple Intelligence is still downloading its model."
    case .unavailable: return "Apple Intelligence is not available."
    }
}

func describe(_ error: Error) -> (String, String) {
    if let e = error as? LanguageModelSession.GenerationError {
        switch e {
        case .exceededContextWindowSize: return ("context", "The page is too long for the on-device model.")
        case .guardrailViolation: return ("guardrail", "Apple Intelligence declined to process this page.")
        case .unsupportedLanguageOrLocale: return ("language", "Apple Intelligence does not support this page's language yet.")
        case .assetsUnavailable: return ("assets", "Apple Intelligence is not ready yet.")
        case .rateLimited: return ("busy", "Apple Intelligence is busy. Try again shortly.")
        default: return ("generation", "Apple Intelligence could not finish: \(e.localizedDescription)")
        }
    }
    return ("error", error.localizedDescription)
}

func clean(_ s: String) -> String {
    s.replacingOccurrences(of: "[\\r\\n,]+", with: " ", options: .regularExpression)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespaces)
}

// The on-device model has a 4096-token window shared by instructions, prompt and answer,
// so the article is cut to fit, and cut further if the model still runs out of room.
func summarize(_ req: Request, model: SystemLanguageModel) async throws -> [String: Any] {
    let body = (req.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if body.isEmpty { fail("empty", "This note has no text to summarize.") }
    let known = Array(Set((req.subjects ?? []).map(clean).filter { !$0.isEmpty })).sorted().prefix(30)
    var limit = 7000
    while true {
        let session = LanguageModelSession(model: model, instructions: """
            You summarize saved web pages for a personal reading notebook. Write plain sentences with no \
            preamble. Then name the subject the page belongs under: broad enough that related pages share it, \
            for example "Machine learning", "Baking" or "Iceland travel". If one of the existing subjects fits, \
            use it exactly as written.
            """)
        let prompt = """
            Existing subjects: \(known.isEmpty ? "(none yet)" : known.joined(separator: " | "))

            Title: \(req.title ?? "Untitled")
            URL: \(req.url ?? "")

            \(String(body.prefix(limit)))
            """
        do {
            let out = try await session.respond(to: prompt, generating: NoteInsight.self).content
            let summary = out.summary.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            var seen = Set<String>()
            let topics = out.topics.map(clean).filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
            return ["ok": true, "summary": summary, "topics": Array(topics.prefix(3))]
        } catch LanguageModelSession.GenerationError.exceededContextWindowSize where limit > 1500 {
            limit /= 2
        }
    }
}

// Groups notes in small batches (the window is small); later batches see the labels chosen so far.
func organize(_ req: Request, model: SystemLanguageModel) async throws -> [String: Any] {
    let notes = req.notes ?? []
    var labels = (req.subjects ?? []).map(clean).filter { !$0.isEmpty }
    var result: [[String: String]] = []
    let batch = 25
    var start = 0
    while start < notes.count {
        let chunk = Array(notes[start..<min(start + batch, notes.count)])
        let lines = chunk.enumerated().map { i, n in
            "\(i + 1). \(clean(n.title ?? "Untitled")) - \(String((n.summary ?? "").prefix(160)))"
        }
        let session = LanguageModelSession(model: model, instructions: """
            You sort a personal notebook of saved web pages into subjects by what each page is about, \
            not by shared words. Use a small set of subjects a person would recognise as folders. \
            Pages about the same field belong together even when they use different words. \
            Reuse an existing subject exactly when it fits. A page that fits nothing goes under "Other".
            """)
        let prompt = """
            Existing subjects: \(labels.isEmpty ? "(none)" : labels.suffix(40).joined(separator: " | "))

            Notes:
            \(lines.joined(separator: "\n"))
            """
        let out = try await session.respond(to: prompt, generating: Grouping.self).content
        for a in out.assignments where a.number >= 1 && a.number <= chunk.count {
            let s = clean(a.subject)
            if s.isEmpty { continue }
            result.append(["id": chunk[a.number - 1].id, "subject": s])
            if s.lowercased() != "other" && !labels.contains(where: { $0.lowercased() == s.lowercased() }) { labels.append(s) }
        }
        start += batch
    }
    return ["ok": true, "assignments": result]
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let req = try? JSONDecoder().decode(Request.self, from: input) else { fail("request", "Unreadable request.") }
let model = SystemLanguageModel.default
let reason = unavailableReason(model)
if req.cmd == "status" {
    var out: [String: Any] = ["ok": true, "available": reason == nil]
    if let reason { out["reason"] = reason }
    emit(out)
    exit(0)
}
if let reason { fail("unavailable", reason) }
do {
    switch req.cmd {
    case "summarize": emit(try await summarize(req, model: model))
    case "organize": emit(try await organize(req, model: model))
    default: fail("request", "Unknown command \(req.cmd).")
    }
} catch {
    let (code, message) = describe(error)
    fail(code, message)
}
