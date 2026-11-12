// paseboon-auth: ask macOS to confirm the logged-in user (Touch ID or account password).
//   paseboon-auth --check            exit 0 if available (no prompt), 3 if not
//   paseboon-auth "reason text"      shows the system prompt
// Exit codes: 0 ok, 1 authentication failed, 2 cancelled, 3 unavailable, 4 bad usage
import Foundation
import LocalAuthentication

let args = CommandLine.arguments
guard args.count == 2 else { FileHandle.standardError.write("usage: paseboon-auth --check | <reason>\n".data(using: .utf8)!); exit(4) }
let context = LAContext()
var error: NSError?
let policy = LAPolicy.deviceOwnerAuthentication   // Touch ID, with the account password as fallback
guard context.canEvaluatePolicy(policy, error: &error) else {
    print("unavailable: \(error?.localizedDescription ?? "unknown")"); exit(3)
}
if args[1] == "--check" {
    print("available biometry=\(context.biometryType == .touchID ? "touchID" : context.biometryType == .none ? "none" : "other")")
    exit(0)
}
let done = DispatchSemaphore(value: 0)
var code: Int32 = 1
context.evaluatePolicy(policy, localizedReason: String(args[1].prefix(150))) { ok, err in
    if ok { code = 0 }
    else if let e = err as? LAError {
        switch e.code {
        case .userCancel, .systemCancel, .appCancel, .userFallback: code = 2
        case .authenticationFailed: code = 1
        default: code = 3
        }
        print("error: \(e.code.rawValue)")
    }
    done.signal()
}
done.wait()
exit(code)
