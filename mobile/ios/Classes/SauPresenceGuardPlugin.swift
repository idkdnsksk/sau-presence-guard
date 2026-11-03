import CryptoKit
import DeviceCheck
import Flutter
import UIKit

public final class SauPresenceGuardPlugin: NSObject, FlutterPlugin {
  private let keyIdStore = "sau_presence_app_attest_key_id"
  private let registeredStore = "sau_presence_app_attest_registered"

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "kz.sau.presence_guard/device_trust",
      binaryMessenger: registrar.messenger()
    )
    registrar.addMethodCallDelegate(SauPresenceGuardPlugin(), channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "getDeviceSecuritySignals":
      result([
        "isEmulator": isSimulator,
        "isRooted": false,
        "isJailbroken": isJailbroken,
      ])
    case "getAppAttestEvidence":
      guard
        let args = call.arguments as? [String: Any],
        let challenge = args["challenge"] as? String,
        let clientData = args["clientData"] as? String
      else {
        result(FlutterError(code: "INVALID_ARGUMENTS", message: "challenge and clientData are required", details: nil))
        return
      }
      appAttestEvidence(challenge: challenge, clientData: clientData, result: result)
    case "markAppAttestRegistered":
      UserDefaults.standard.set(true, forKey: registeredStore)
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func appAttestEvidence(challenge: String, clientData: String, result: @escaping FlutterResult) {
    let service = DCAppAttestService.shared
    guard service.isSupported else {
      result(FlutterError(code: "APP_ATTEST_UNSUPPORTED", message: "App Attest is not supported", details: nil))
      return
    }
    Task {
      do {
        var keyId = UserDefaults.standard.string(forKey: keyIdStore)
        if keyId == nil {
          keyId = try await service.generateKey()
          UserDefaults.standard.set(keyId, forKey: keyIdStore)
        }
        guard let keyId else { throw AppAttestError.missingKey }
        if !UserDefaults.standard.bool(forKey: registeredStore) {
          let challengeHash = Data(SHA256.hash(data: Data(challenge.utf8)))
          let attestation = try await service.attestKey(keyId, clientDataHash: challengeHash)
          result(["mode": "registration", "keyId": keyId, "attestation": attestation.base64EncodedString()])
        } else {
          let payloadHash = Data(SHA256.hash(data: Data(clientData.utf8)))
          let assertion = try await service.generateAssertion(keyId, clientDataHash: payloadHash)
          result(["mode": "assertion", "keyId": keyId, "assertion": assertion.base64EncodedString()])
        }
      } catch {
        result(FlutterError(code: "APP_ATTEST_FAILED", message: error.localizedDescription, details: nil))
      }
    }
  }

  private var isSimulator: Bool {
    #if targetEnvironment(simulator)
      return true
    #else
      return false
    #endif
  }

  private var isJailbroken: Bool {
    #if targetEnvironment(simulator)
      return false
    #else
      let paths = [
        "/Applications/Cydia.app", "/Library/MobileSubstrate/MobileSubstrate.dylib",
        "/bin/bash", "/usr/sbin/sshd", "/etc/apt", "/private/var/lib/apt/",
      ]
      if paths.contains(where: { FileManager.default.fileExists(atPath: $0) }) { return true }
      let probe = "/private/sau-presence-jailbreak-probe"
      do {
        try "probe".write(toFile: probe, atomically: true, encoding: .utf8)
        try FileManager.default.removeItem(atPath: probe)
        return true
      } catch {
        return false
      }
    #endif
  }
}

private enum AppAttestError: Error { case missingKey }
