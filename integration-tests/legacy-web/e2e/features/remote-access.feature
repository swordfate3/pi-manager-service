Feature: Portable remote access onboarding
  Scenario Outline: Generate remote connection and recovery materials without storing passwords
    When I open remote onboarding on a real Pi in "<screen>" with "<locale>"
    Then onboarding can be skipped and reopened from settings
    When I generate a new single-session deployment for pi.example.com
    Then deployment materials are pending and login management never requests a password
    Examples:
      | screen  | locale |
      | desktop | en     |
      | mobile  | zh-CN  |

  Scenario: A changed Pi listener port invalidates and refreshes deployment materials
    When I open remote onboarding on a real Pi in "desktop" with "en"
    And I generate a new single-session deployment for pi.example.com
    Then deployment materials are pending and login management never requests a password
    When I change the Pi listener port to 4321
    Then generated materials are invalidated
    When I generate materials again
    Then the generated connection plan uses Pi listener port 4321
