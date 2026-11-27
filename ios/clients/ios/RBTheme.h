#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN

// RokBot-owned visual tokens shared by native iOS surfaces. Values follow the
// desktop 1.3.0 Sand tokens (light / dark) already used by Android UiChrome.
UIColor *RBThemeChrome(void);          // page background
UIColor *RBThemeElevated(void);        // cards, sheets, floating menus
UIColor *RBThemeSecondaryFill(void);   // chips, icon wells, input fills
UIColor *RBThemeHover(void);           // pressed rows
UIColor *RBThemeBorder(void);          // hairlines and card borders
UIColor *RBThemeTextPrimary(void);
UIColor *RBThemeTextSecondary(void);
UIColor *RBThemeTextMuted(void);
UIColor *RBThemeAccent(void);          // selection check, links
UIColor *RBThemeDanger(void);
UIColor *RBThemePrimaryButton(void);   // filled primary action background
UIColor *RBThemeOnPrimaryButton(void); // filled primary action foreground
UIColor *RBThemeScrim(void);

// Dynamic-type aware system font scaled from a base point size.
UIFont *RBThemeFont(CGFloat size, UIFontWeight weight);

// Vector glyphs (no SF Symbols / emoji). All are template images tinted by tintColor.
typedef NS_ENUM(NSInteger, RBGlyph) {
  RBGlyphCheck = 0,
  RBGlyphChevronDown,
  RBGlyphChevronRight,
  RBGlyphClose,
  RBGlyphPlus,
  RBGlyphBolt,     // quick phrase
  RBGlyphSparkle,  // AI suggestion
  RBGlyphArrowUp,
  RBGlyphArrowDown,
  RBGlyphPencil,
  RBGlyphTrash,
  RBGlyphBack,
  RBGlyphSend,
  RBGlyphPerson,
  RBGlyphGroup,
};
UIImage *RBGlyphImage(RBGlyph glyph, CGFloat size, CGFloat lineWidth);

// Card container with Sand radius, elevated fill and hairline border.
UIView *RBThemeCard(CGFloat radius);
// Styles a button as RokBot capsule. primary => filled; otherwise secondary fill.
void RBThemeStyleButton(UIButton *button, NSString *title, BOOL primary);

NS_ASSUME_NONNULL_END
