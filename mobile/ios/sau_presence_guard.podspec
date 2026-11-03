Pod::Spec.new do |s|
  s.name             = 'sau_presence_guard'
  s.version          = '1.0.0'
  s.summary          = 'Secure attendance with App Attest and foreground geolocation.'
  s.description      = 'Native device trust bridge for the SAU Presence Guard Flutter module.'
  s.homepage         = 'https://astanahub.com/'
  s.license          = { :type => 'MIT' }
  s.author           = 'SAU Presence Guard contributors'
  s.source           = { :path => '.' }
  s.source_files     = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform = :ios, '14.0'
  s.swift_version = '5.9'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386' }
end
