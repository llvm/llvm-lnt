SECTIONS {
  .text (. + 0x1000) : {
    *(.text)
    *(.text.correct)
  }
} INSERT BEFORE .init;
/* .init is the first section placed to the executable segment in a binary
 * produced by clang at the time of writing
 */
